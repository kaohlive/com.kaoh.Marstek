'use strict';

const Homey = require('homey');
const ModbusClient = require('../../api/ModbusClient');

// Marstek Duravolt / Venus D device.
//
// Phase 1 scope: read-only minimal driver that proves the connect path and
// validates the two registers we already know work on Venus D from the
// earlier tester logs: 32105 (battery capacity, returned successfully
// before subsequent reads timed out) and 31000 (device name, returned
// "VNSD-0"). Adding more reads happens phase-by-phase with tester
// validation between each step.
//
// Register map for Duravolt (per ViperRNMC HA project, to be validated
// against the Duravolt PDF in documentation/):
//   31000  device name (10 registers / 20 ASCII bytes)
//   31101  firmware version (timeouts on tested fw 149 - SKIP for now)
//   32105  battery rated capacity in 0.001 kWh (we have this working)
//   34002  SOC % (was at 32104 on Venus E)
//   30100  battery voltage (was at 32100 on Venus E)
//   30101  battery current (was at 32101 on Venus E)
//   30006  AC power int32 (was at 32202 on Venus E)
//   37004  AC current with scaling 0.004 (was at 32201 with 0.01/0.001 on E)
//   30020-30040  PV / MPPT registers (NEW - not on Venus E)
//
// Phase 1 reads ONLY 31000 (during pair test) and 32105 (during poll).
// Capacity-only feels barren as a battery widget, so we also try SOC at
// 34002 - if it works on our tester we add it to the visible capabilities;
// if it times out we drop it for now and revisit in Phase 2.

class DuravoltDevice extends Homey.Device {

  async onInit() {
    this.log('DuravoltDevice has been initialized');

    this._isDeleted = false;
    this.settings = this.getSettings();
    this.modbus = new ModbusClient();

    if (this.settings.connection_timeout) {
      this.modbus.connectionTimeout = this.settings.connection_timeout;
    }

    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = this.settings.max_consecutive_errors || 3;

    this.setupModbusHandlers();
    this.startPolling();
    this.setupCapabilityListeners();
  }

  // Mirror the venus driver's safe-wrapper pattern from v1.3.19. Calls
  // happen fire-and-forget from poll paths; after device delete they would
  // reject with "Device not found" and surface as unhandledRejection on the
  // app process. Swallow after delete to keep support logs clean.
  _setSettingsSafe(settings) {
    return this.setSettings(settings).catch((err) => {
      if (!this._isDeleted) this.log('setSettings failed:', err.message);
    });
  }
  _setUnavailableSafe(reason) {
    return this.setUnavailable(reason).catch((err) => {
      if (!this._isDeleted) this.log('setUnavailable failed:', err.message);
    });
  }
  _setAvailableSafe() {
    return this.setAvailable().catch((err) => {
      if (!this._isDeleted) this.log('setAvailable failed:', err.message);
    });
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);
    this.settings = newSettings;

    if (changedKeys.includes('connection_timeout')) {
      this.modbus.connectionTimeout = newSettings.connection_timeout;
    }
    if (changedKeys.includes('max_consecutive_errors')) {
      this.maxConsecutiveErrors = newSettings.max_consecutive_errors;
    }
    if (changedKeys.includes('ip') || changedKeys.includes('port') || changedKeys.includes('poll_interval')) {
      await this.restartPolling();
    }
  }

  setupModbusHandlers() {
    this.modbus.on('connect', () => {
      this._setAvailableSafe();
      this.consecutiveErrors = 0;
      this.log('Connected to Modbus device');
      this.processDeviceStaticInfo(this.settings.slave_id || 1);
    });

    this.modbus.on('error', (error) => {
      this.log('Modbus connection error:', error.message);
    });

    this.modbus.on('close', () => {
      this.log('Modbus connection closed');
    });
  }

  setupCapabilityListeners() {
    // Phase 5 will add onoff / target_power / etc. For Phase 1 the device
    // is read-only.
  }

  async connectModbus() {
    if (this.modbus.isConnected()) {
      return true;
    }
    try {
      const success = await this.modbus.connect({
        ip: this.settings.ip,
        port: this.settings.port || 502
      });
      return success;
    } catch (error) {
      this.log('Modbus connection failed:', error);
      return false;
    }
  }

  disconnectModbus() {
    if (this.modbus) {
      this.modbus.disconnect();
      this.log('Disconnected from Modbus device');
    }
  }

  startPolling() {
    this.stopPolling();
    const interval = this.settings.poll_interval || 5000;
    this.pollInterval = setInterval(async () => {
      await this.pollData();
    }, interval);
    setTimeout(() => this.pollData(), 1000);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async restartPolling() {
    this.stopPolling();
    this.disconnectModbus();
    this.startPolling();
  }

  async processDeviceStaticInfo(slaveId) {
    try {
      // Rated capacity in 0.001 kWh resolution. Confirmed working on Venus D
      // tester (this register existed since Duravolt protocol v1.0).
      const reg_energy = await this.modbus.readHoldingRegisters(slaveId, 32105, 1);
      this.batteryCapacity = ModbusClient.bufferToUint16(Buffer.concat(reg_energy)) * 0.001;

      // Device name (10 registers ASCII). Confirmed working - tester saw
      // "VNSD-0" come through before later reads started timing out.
      const reg_name = await this.modbus.readHoldingRegisters(slaveId, 31000, 10);
      const deviceName = ModbusClient.bufferToString(reg_name);

      // Firmware register 31101 timed out on the only tester we have data
      // for (Duravolt firmware 149). We attempt it but accept failure.
      let firmwareVersion = 'unknown';
      try {
        const reg_fw = await this.modbus.readHoldingRegisters(slaveId, 31101, 1);
        firmwareVersion = ModbusClient.bufferToUint16(Buffer.concat(reg_fw)).toString();
      } catch (e) {
        this.log('Firmware read failed (Duravolt fw 149 is known to time out here):', e.message);
      }

      this.log(`Detected Duravolt: name="${deviceName}" capacity=${this.batteryCapacity}kWh firmware=${firmwareVersion}`);

      this._setSettingsSafe({
        storage_capacity: this.batteryCapacity + ' kwh',
        device_name: deviceName,
        firmware: firmwareVersion,
      });

      // Expose capacity as a capability so users see something in the UI
      // right away.
      this.setCapabilityValue('meter_power.capacity', this.batteryCapacity).catch(this.error);
    } catch (error) {
      this.log('Device static info error:', error);
      this._setUnavailableSafe(`Retrieval of static info failed: ${error.message}`);
    }
  }

  async pollData() {
    if (this._isDeleted) return;

    if (!await this.connectModbus()) {
      this.consecutiveErrors++;
      this.log(`Connection failed (${this.consecutiveErrors}/${this.maxConsecutiveErrors})`);
      if (this.consecutiveErrors >= this.maxConsecutiveErrors && !this._isDeleted) {
        this._setUnavailableSafe(`Connection failed after ${this.maxConsecutiveErrors} attempts`);
      }
      return;
    }

    try {
      const slaveId = this.settings.slave_id || 1;
      console.log('[Duravolt] Polling slave', slaveId);

      // Phase 1: try SOC at the Duravolt-specific register 34002 (Venus E
      // uses 32104). If this works on the tester we know our register-map
      // hypothesis holds and Phase 2 can proceed with confidence.
      try {
        const reg_soc = await this.modbus.readHoldingRegisters(slaveId, 34002, 1);
        const soc = ModbusClient.bufferToUint16(Buffer.concat(reg_soc));
        this.setCapabilityValue('measure_battery', soc).catch(this.error);

        // Derive stored energy from SOC + capacity.
        if (this.batteryCapacity) {
          const stored = this.batteryCapacity * (soc / 100);
          this.setCapabilityValue('meter_power.capacity', stored).catch(this.error);
        }
      } catch (e) {
        this.log('SOC read at 34002 failed:', e.message);
        // Do not throw - we want the polling loop to continue and let
        // counters track health. Phase 2 will add more reads and we'll
        // see which ones work.
      }

      this.consecutiveErrors = 0;
      if (!this._isDeleted && !this.getAvailable()) {
        this._setAvailableSafe();
      }
    } catch (error) {
      this.consecutiveErrors++;
      this.log(`Polling error (${this.consecutiveErrors}/${this.maxConsecutiveErrors}):`, error.message);
      if (this.consecutiveErrors >= this.maxConsecutiveErrors && !this._isDeleted) {
        this._setUnavailableSafe(`Polling failed ${this.maxConsecutiveErrors} times: ${error.message}`);
      }
    }
  }

  async onDeleted() {
    this.log('DuravoltDevice deleted');
    this._isDeleted = true;
    this.stopPolling();
    this.disconnectModbus();
  }

  // Diagnostic API helpers - same shape as venus driver so app.js can route
  // settings-page reads through this device's existing ModbusClient.
  async apiReadRegister(address, count = 1) {
    if (!await this.connectModbus()) {
      throw new Error('Modbus connection failed');
    }
    const slaveId = this.settings.slave_id || 1;
    const result = await this.modbus.readHoldingRegisters(slaveId, address, count);
    const buffer = Buffer.concat(result);
    const response = {
      success: true,
      address,
      count,
      raw: Array.from(buffer),
      uint16: ModbusClient.bufferToUint16(buffer),
      int16: ModbusClient.bufferToInt16(buffer),
      hex: buffer.toString('hex').toUpperCase(),
    };
    if (count >= 2) {
      response.uint32 = ModbusClient.bufferToUint32(buffer);
      response.int32 = ModbusClient.bufferToInt32(buffer);
    }
    return response;
  }

  async apiWriteRegister(address, value) {
    if (!await this.connectModbus()) {
      throw new Error('Modbus connection failed');
    }
    const slaveId = this.settings.slave_id || 1;
    await this.modbus.writeSingleRegister(slaveId, address, value);
    this.log(`API write: register ${address} = ${value}`);
    return { success: true, address, value };
  }
}

module.exports = DuravoltDevice;
