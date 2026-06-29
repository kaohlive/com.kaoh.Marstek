'use strict';

const Homey = require('homey');
const ModbusClient = require('../../api/ModbusClient');

// Marstek Venus D device (also marketed by some resellers as "Duravolt").
//
// Phase 1 scope: read-only minimal driver - device name, capacity, SOC.
// Adding more reads happens phase-by-phase with tester validation
// between each step.
//
// Authoritative register map: the Duravolt v1.1 PDF (in documentation/)
// extended with community scans on firmware v153 + BMS v213, published
// 2025-08-14 as a Google Sheets datasheet. A local copy lives at
// documentation/duravolt_modbus_v1.1_fw153.txt. Many registers turn
// out to be the SAME addresses Venus E uses (the "different register
// map" intuition from the early tester logs was overstated - the real
// differences are PV/MPPT registers and a few scaling tweaks):
//
//   31000  device name              (20 char,  same as Venus E)
//   31101  firmware version         (u16, exists v153+, missing on v149)
//   32100  battery voltage          (u16 0.01V, same as Venus E)
//   32101  battery current          (s16 0.01A, same as Venus E)
//   32102  battery power            (s32 1W,    same as Venus E)
//   32104  battery SOC              (u16 0.1%,  CORRECTED from 34002)
//   32105  battery rated capacity   (u16 0.001 kWh on v148+, 0.01 on v147)
//   32200  AC voltage               (u16 0.1V,  same as Venus E)
//   32201  AC current               (u16 0.01A, same as Venus E)
//   32202  AC power                 (s32 1W,    same as Venus E)
//   32204  AC frequency             (u16 0.01Hz)
//   32300-32302  AC offgrid (UPS)   (Venus E doesn't have this)
//   35000-35002  internal temps     (s16 0.1C,  same as Venus E)
//   35010-35011  cell temps         (BMS v213 changed unit to 1C)
//   35100  inverter state           (u16, same enum as Venus E)
//   37004  AC power (alias 32202)
//   37005  battery SOC (alias 32104)
//   42000  RS485 control gate       (write 0x55AA to enable 42010-43129)
//   42010-42021  forcible (dis)charge controls (Venus E parity)
//   43000  user work mode
//   43100-43129  discharge schedule (6 slots)
//   44000-44003  cutoff SoC + max power (Venus E parity)
//
// Phase 1 reads: 31000 (during pair test), 32105 + 32104 (during poll).

class VenusDDevice extends Homey.Device {

  async onInit() {
    this.log('VenusDDevice has been initialized');

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

      // 31101 (firmware) is deliberately NOT read on Venus D. The register
      // does not exist on Venus D firmware - the device responds with
      // Modbus exception 2 (Illegal data address) and then enters the same
      // "deaf after error" lockup state we see on V3, which kills all
      // subsequent reads in this session. Skipping the read entirely
      // avoids the trigger. Firmware stays "unknown" until we find a
      // register on Venus D that actually returns it.
      const firmwareVersion = 'unknown';

      this.log(`Detected Venus D: name="${deviceName}" capacity=${this.batteryCapacity}kWh firmware=${firmwareVersion}`);

      this._setSettingsSafe({
        storage_capacity: this.batteryCapacity + ' kwh',
        device_name: deviceName,
        firmware: firmwareVersion,
      });

      // Rated capacity goes in the settings label above; meter_power.capacity
      // is labelled "Stored energy available" and is owned by pollData
      // (capacity x soc). Writing rated capacity here would briefly show
      // the wrong value before the first SOC poll overrides it.
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
      console.log('[VenusD] Polling slave', slaveId);

      // SOC at register 32104 (u16, scaling 0.1% - so raw 500 = 50%).
      // Per the Duravolt v1.1 PDF + community datasheet (fw v153 scan).
      // Earlier code used 34002 from ViperRNMC's HA project but that
      // register isn't in the authoritative documentation - 32104 is.
      // If 32104 fails on some firmware, register 37005 is documented
      // as an alias ("Same as 32104").
      try {
        const reg_soc = await this.modbus.readHoldingRegisters(slaveId, 32104, 1);
        const socRaw = ModbusClient.bufferToUint16(Buffer.concat(reg_soc));
        const soc = socRaw / 10;
        this.setCapabilityValue('measure_battery', soc).catch(this.error);

        // Derive stored energy from SOC + capacity. This is the only
        // writer of meter_power.capacity ("Stored energy available") -
        // static info does NOT touch this capability, see comment there.
        if (this.batteryCapacity) {
          const stored = this.batteryCapacity * (soc / 100);
          this.setCapabilityValue('meter_power.capacity', stored).catch(this.error);
        }
      } catch (e) {
        this.log('SOC read at 32104 failed:', e.message);
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
    this.log('VenusDDevice deleted');
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

module.exports = VenusDDevice;
