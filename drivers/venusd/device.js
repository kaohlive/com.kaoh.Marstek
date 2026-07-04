'use strict';

const Homey = require('homey');
const ModbusClient = require('../../api/ModbusClient');

// Marstek Venus D device (also marketed by some resellers as "Duravolt").
//
// Rewired in v1.5.4 to poll the same 32xxx/33xxx/35xxx/4xxxx register
// ranges as the Venus E driver. This is safe because the community-
// extended Duravolt v1.1 datasheet (scanned on firmware v153, saved in
// documentation/duravolt_modbus_v1.1_fw153.txt) confirms these
// addresses are shared with Venus E on Duravolt hardware. Tester chats
// from the pre-v149-firmware era also confirmed most of these reads
// were working when the tester was mistakenly paired on the Venus
// driver.
//
// FAULT REGISTERS (36xxx):
// - 36000 (system alarms), 36100 (grid faults), 36101 (battery faults)
//   ARE read and fed into the alarm_generic capability + the venusd_*_
//   fault flow triggers. Tester dumps across v158.1 and v149 showed these
//   at 0x0000; that means "no fault right now", not "always empty".
// - 36103 is deliberately NOT read. On v149 it holds a stable constant
//   (0x0940) that our PDF-based bit interpretation reads as three
//   simultaneous hardware faults on a battery that is working fine.
//   Marstek shifted the semantics of 36103 in newer firmware.
// - 36104 is absent on every firmware tested.
//
// DELIBERATELY OMITTED:
// - Battery current (32101) and battery power (32102) - the tester
//   confirmed these return garbage on Venus D (32101 always 0.02A,
//   32102 always 0W) even on the working v147 firmware. Skipping
//   reads avoids populating misleading values.
// - PV/MPPT registers - not documented in the community datasheet.
//   The Marstek local API (UDP JSON) exposes Solar power; the
//   Modbus range does not. Users needing PV data should combine
//   this driver with the Marstek Local API Homey app.
// - Firmware register 31101 - times out on v149 which triggers a
//   deaf-after-error lockup. Same skip as v1.5.1 kept.
// - Mode-events ringbuffer (Venus E's write/read latency diagnostic).
//   Diagnostic-only, not needed for functional parity.

class VenusDDevice extends Homey.Device {

  async onInit() {
    this.log('VenusDDevice has been initialized');

    this._isDeleted = false;
    this.settings = this.getSettings();
    this.modbus = new ModbusClient();

    if (this.settings.connection_timeout) {
      this.modbus.connectionTimeout = this.settings.connection_timeout;
    }

    this.previousValues = {};
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = this.settings.max_consecutive_errors || 3;

    this.setupModbusHandlers();
    await this.repairCapabilities();
    this.startPolling();
    this.setupCapabilityListeners();
    this.registerFlowCardTriggers();

    this.batteryCapacity = 0;
    this.deviceVersion = 'venusd';
  }

  // Safe wrappers for Homey device APIs called fire-and-forget from poll
  // paths. Prevents unhandledRejection after device delete.
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

  async repairCapabilities() {
    const needed = [
      'onoff', 'measure_battery', 'meter_power.capacity',
      'measure_power', 'measure_power.imported', 'measure_power.exported',
      'meter_power.imported', 'meter_power.exported',
      'measure_voltage', 'measure_current', 'measure_temperature',
      'measure_voltage.battery',
      'measure_temperature.mos1', 'measure_temperature.mos2',
      'operation_mode', 'battery_charging_state', 'alarm_generic',
      'force_charge_mode', 'force_charge_target', 'backup_mode',
      'user_work_mode', 'target_power', 'target_power_mode',
      'force_charge_power', 'force_discharge_power',
      'max_charge_power_limit', 'max_discharge_power_limit',
    ];
    let neededFix = false;
    for (const cap of needed) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
          this.log(`Registered missing ${cap} capability`);
          neededFix = true;
        } catch (err) {
          this.log(`Failed to add capability ${cap}:`, err.message);
        }
      }
    }
    // Remove stale capabilities that shipped in earlier Venus D Phase 1
    // compose but that we no longer populate (PV placeholders, broken
    // battery-side measurements). Silences empty tiles in the UI.
    const removeCaps = [
      'measure_power.battery', 'measure_current.battery',
      'measure_power.pv', 'measure_voltage.pv', 'measure_current.pv', 'meter_power.pv',
    ];
    for (const cap of removeCaps) {
      if (this.hasCapability(cap)) {
        try {
          await this.removeCapability(cap);
          this.log(`Removed obsolete ${cap} capability`);
          neededFix = true;
        } catch (err) {
          this.log(`Failed to remove capability ${cap}:`, err.message);
        }
      }
    }
    return neededFix;
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
    if (changedKeys.includes('charging_cutoff_soc')) {
      await this.setChargingCutoffSoc(newSettings.charging_cutoff_soc);
    }
    if (changedKeys.includes('discharging_cutoff_soc')) {
      await this.setDischargingCutoffSoc(newSettings.discharging_cutoff_soc);
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
      this.log('Modbus connection closed - will attempt reconnection');
    });
  }

  async connectModbus() {
    if (this.modbus.isConnected()) return true;
    try {
      const success = await this.modbus.connect({
        ip: this.settings.ip,
        port: this.settings.port || 502,
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

  // Diagnostic API delegates - called via app.js endpoints from the
  // settings page. Same pattern as Venus E: route reads/writes through
  // this device's own ModbusClient so the settings-page dump does not
  // open a parallel socket that competes with the poll.
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

  async apiPollState() {
    if (!await this.connectModbus()) {
      throw new Error('Modbus connection failed');
    }
    const slaveId = this.settings.slave_id || 1;
    const data = {
      deviceInfo: {},
      batteryState: {},
      systemState: {},
      controlRegisters: {},
      protectionSettings: {},
    };
    const safeRead = async (label, addr, count, transform) => {
      try {
        const r = await this.modbus.readHoldingRegisters(slaveId, addr, count);
        return transform(r);
      } catch (e) {
        return 'Error: ' + e.message;
      }
    };

    data.deviceInfo['31000_device_name'] = await safeRead('name', 31000, 10,
      (r) => ModbusClient.bufferToString(r));
    data.deviceInfo['32105_total_energy_kwh'] = await safeRead('energy', 32105, 1,
      (r) => ModbusClient.bufferToUint16(Buffer.concat(r)) * 0.001);

    data.batteryState['32100_battery_voltage_V'] = await safeRead('battV', 32100, 1,
      (r) => ModbusClient.bufferToUint16(Buffer.concat(r)) * 0.01);
    data.batteryState['32104_soc_percent'] = await safeRead('soc', 32104, 1,
      (r) => ModbusClient.bufferToUint16(Buffer.concat(r)) * 0.1);
    data.batteryState['32200_ac_voltage_V'] = await safeRead('acV', 32200, 1,
      (r) => ModbusClient.bufferToUint16(Buffer.concat(r)) * 0.1);
    data.batteryState['32201_ac_current_A'] = await safeRead('acA', 32201, 1,
      (r) => ModbusClient.bufferToInt16(Buffer.concat(r)) * 0.01);
    data.batteryState['32202_ac_power_W'] = await safeRead('acW', 32202, 2,
      (r) => ModbusClient.bufferToInt32(Buffer.concat(r)));
    data.batteryState['33000_total_charge_energy_kWh'] = await safeRead('chgE', 33000, 2,
      (r) => ModbusClient.bufferToUint32(Buffer.concat(r)) * 0.01);
    data.batteryState['33002_total_discharge_energy_kWh'] = await safeRead('disE', 33002, 2,
      (r) => ModbusClient.bufferToInt32(Buffer.concat(r)) * 0.01);
    data.batteryState['35000_internal_temp_C'] = await safeRead('tempInt', 35000, 1,
      (r) => ModbusClient.bufferToInt16(Buffer.concat(r)) * 0.1);
    data.batteryState['35001_mos1_temp_C'] = await safeRead('tempMos1', 35001, 1,
      (r) => ModbusClient.bufferToInt16(Buffer.concat(r)) * 0.1);
    data.batteryState['35002_mos2_temp_C'] = await safeRead('tempMos2', 35002, 1,
      (r) => ModbusClient.bufferToInt16(Buffer.concat(r)) * 0.1);

    const stateNames = ['sleep', 'standby', 'charge', 'discharge', 'backup', 'update', 'bypass'];
    data.systemState['35100_inverter_state'] = await safeRead('inv', 35100, 1, (r) => {
      const v = ModbusClient.bufferToUint16(Buffer.concat(r));
      return { raw: v, name: stateNames[v] || 'unknown' };
    });

    data.controlRegisters['41200_backup_mode'] = await safeRead('backup', 41200, 1, (r) => {
      const v = ModbusClient.bufferToUint16(Buffer.concat(r));
      return { raw: v, enabled: v === 0 };
    });
    data.controlRegisters['42000_rs485_control'] = await safeRead('rs485', 42000, 1, (r) => {
      const v = ModbusClient.bufferToUint16(Buffer.concat(r));
      return { raw: v, hex: '0x' + v.toString(16).toUpperCase(), modbus_enabled: v === 21930 };
    });
    const forceModeNames = ['none', 'force_charge', 'force_discharge'];
    data.controlRegisters['42010_force_mode'] = await safeRead('fmode', 42010, 1, (r) => {
      const v = ModbusClient.bufferToUint16(Buffer.concat(r));
      return { raw: v, name: forceModeNames[v] || 'unknown' };
    });
    data.controlRegisters['42011_charge_to_soc_percent'] = await safeRead('fsoc', 42011, 1,
      (r) => ModbusClient.bufferToUint16(Buffer.concat(r)));
    data.controlRegisters['42020_force_charge_power_W'] = await safeRead('fcp', 42020, 1,
      (r) => ModbusClient.bufferToUint16(Buffer.concat(r)));
    data.controlRegisters['42021_force_discharge_power_W'] = await safeRead('fdp', 42021, 1,
      (r) => ModbusClient.bufferToUint16(Buffer.concat(r)));
    const workModeNames = ['manual', 'anti_feed', 'trade_mode', 'control_mode'];
    data.controlRegisters['43000_user_work_mode'] = await safeRead('wmode', 43000, 1, (r) => {
      const v = ModbusClient.bufferToUint16(Buffer.concat(r));
      return { raw: v, name: workModeNames[v] || 'unknown (' + v + ')' };
    });

    data.protectionSettings['44000_charging_cutoff_soc_percent'] = await safeRead('ccs', 44000, 1,
      (r) => ModbusClient.bufferToUint16(Buffer.concat(r)) * 0.1);
    data.protectionSettings['44001_discharging_cutoff_soc_percent'] = await safeRead('dcs', 44001, 1,
      (r) => ModbusClient.bufferToUint16(Buffer.concat(r)) * 0.1);
    data.protectionSettings['44002_max_charge_power_W'] = await safeRead('mcp', 44002, 1,
      (r) => ModbusClient.bufferToUint16(Buffer.concat(r)));
    data.protectionSettings['44003_max_discharge_power_W'] = await safeRead('mdp', 44003, 1,
      (r) => ModbusClient.bufferToUint16(Buffer.concat(r)));

    return { success: true, data };
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
      // Battery rated capacity - u16 * 0.001 kWh on firmware v148+.
      // (v147 used 0.01 - if a very old firmware shows 10x too low
      // capacity in settings, this is the cause. Not worth guarding
      // for since Duravolt v1.1 protocol was v148+.)
      const reg_energy = await this.modbus.readHoldingRegisters(slaveId, 32105, 1);
      this.batteryCapacity = ModbusClient.bufferToUint16(Buffer.concat(reg_energy)) * 0.001;

      const reg_name = await this.modbus.readHoldingRegisters(slaveId, 31000, 10);
      const deviceName = ModbusClient.bufferToString(reg_name);

      // 31101 firmware register deliberately not read on Venus D - see
      // top-of-file comment. Firmware in settings stays "unknown" until
      // we find a register that works reliably across firmware versions.
      const firmwareVersion = 'unknown';

      this.log(`Detected Venus D: name="${deviceName}" capacity=${this.batteryCapacity}kWh firmware=${firmwareVersion}`);

      this._setSettingsSafe({
        storage_capacity: this.batteryCapacity + ' kwh',
        device_name: deviceName,
        firmware: firmwareVersion,
      });

      // Force charge/discharge power settings (writable controls)
      try {
        const reg_forcecharge = await this.modbus.readHoldingRegisters(slaveId, 42020, 1);
        const force_charge = ModbusClient.bufferToUint16(Buffer.concat(reg_forcecharge));
        this.setCapabilityValue('force_charge_power', force_charge).catch(this.error);
      } catch (e) {
        this.log('force_charge_power read failed:', e.message);
      }
      try {
        const reg_forcedischarge = await this.modbus.readHoldingRegisters(slaveId, 42021, 1);
        const force_discharge = ModbusClient.bufferToUint16(Buffer.concat(reg_forcedischarge));
        this.setCapabilityValue('force_discharge_power', force_discharge).catch(this.error);
      } catch (e) {
        this.log('force_discharge_power read failed:', e.message);
      }

      // Charging cutoff SOC (register 44000, 0.1% resolution)
      try {
        const reg_charging_cutoff = await this.modbus.readHoldingRegisters(slaveId, 44000, 1);
        const charging_cutoff_soc = ModbusClient.bufferToUint16(Buffer.concat(reg_charging_cutoff)) * 0.1;
        this._setSettingsSafe({ charging_cutoff_soc });
      } catch (e) {
        this.log('charging cutoff SOC read failed:', e.message);
      }
      // Discharging cutoff SOC (register 44001, 0.1% resolution)
      try {
        const reg_discharging_cutoff = await this.modbus.readHoldingRegisters(slaveId, 44001, 1);
        const discharging_cutoff_soc = ModbusClient.bufferToUint16(Buffer.concat(reg_discharging_cutoff)) * 0.1;
        this._setSettingsSafe({ discharging_cutoff_soc });
      } catch (e) {
        this.log('discharging cutoff SOC read failed:', e.message);
      }
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

      await this.processBatteryState(slaveId);
      await this.processBatteryHealth(slaveId);
      await this.processSystemData(slaveId);

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

  async processBatteryState(slaveId) {
    try {
      // AC output voltage (0.1V)
      const reg_voltage_ac = await this.modbus.readHoldingRegisters(slaveId, 32200, 1);
      const voltage_ac = ModbusClient.bufferToUint16(Buffer.concat(reg_voltage_ac)) * 0.1;
      this.setCapabilityValue('measure_voltage', voltage_ac).catch(this.error);

      // AC output current at register 32201, signed 16-bit.
      // Scaling is 0.001 A per raw unit, NOT 0.01 as the community-scanned
      // datasheet documents. Confirmed empirically: tester screenshots on
      // Venus D firmware v149 read 23.9 A with 0.01 scaling, whereas the
      // same tester's earlier screenshots on the venus driver (which
      // classifies VNSD-0 as v3 and applies 0.001) showed 2.39 A - exactly
      // 10x less, so the raw register value is in tenths of milliamps here.
      // The community datasheet was scanned on firmware v153 which may
      // have a different scaling; if a v153+ tester ever reports 100x too
      // low, branch on firmware.
      const reg_current_ac = await this.modbus.readHoldingRegisters(slaveId, 32201, 1);
      const current_ac = ModbusClient.bufferToInt16(Buffer.concat(reg_current_ac)) * 0.001;
      this.setCapabilityValue('measure_current', current_ac).catch(this.error);

      // AC power (int32 W). Homey convention: positive = export to grid,
      // negative = import. Marstek reports positive when device pushes
      // to grid (discharge). Invert so Homey's energy dashboards read
      // it consistently with other batteries.
      const reg_power_ac = await this.modbus.readHoldingRegisters(slaveId, 32202, 2);
      const power_ac = ModbusClient.bufferToInt32(Buffer.concat(reg_power_ac));
      this.setCapabilityValue('measure_power', (power_ac * -1)).catch(this.error);
      if (power_ac < 0) {
        this.setCapabilityValue('measure_power.imported', Math.abs(power_ac)).catch(this.error);
        this.setCapabilityValue('measure_power.exported', 0).catch(this.error);
      } else {
        this.setCapabilityValue('measure_power.imported', 0).catch(this.error);
        this.setCapabilityValue('measure_power.exported', Math.abs(power_ac)).catch(this.error);
      }

      // SOC at 32104 - u16 in 0.1% units on Venus D (500 = 50%).
      const reg_soc = await this.modbus.readHoldingRegisters(slaveId, 32104, 1);
      const soc = ModbusClient.bufferToUint16(Buffer.concat(reg_soc)) / 10;
      this.setCapabilityValue('measure_battery', soc).catch(this.error);
      if (this.batteryCapacity) {
        const stored_energy = this.batteryCapacity * (soc / 100);
        this.setCapabilityValue('meter_power.capacity', stored_energy).catch(this.error);
      }
      this.triggerSOCEvents(soc);

      // Battery voltage (0.01V)
      const reg_voltage = await this.modbus.readHoldingRegisters(slaveId, 32100, 1);
      const voltage = ModbusClient.bufferToUint16(Buffer.concat(reg_voltage)) * 0.01;
      this.setCapabilityValue('measure_voltage.battery', voltage).catch(this.error);

      // Deliberately NOT reading 32101 (battery current - garbage on
      // Venus D) or 32102 (battery power - always 0 on Venus D). See
      // top-of-file comment.
    } catch (error) {
      this.log('Error processing battery state:', error);
    }
  }

  async processBatteryHealth(slaveId) {
    try {
      const reg_temp_int = await this.modbus.readHoldingRegisters(slaveId, 35000, 1);
      const temp_int = ModbusClient.bufferToInt16(Buffer.concat(reg_temp_int)) * 0.1;
      this.setCapabilityValue('measure_temperature', temp_int).catch(this.error);
      this.triggerTemperatureEvents(temp_int);

      const reg_temp_mos1 = await this.modbus.readHoldingRegisters(slaveId, 35001, 1);
      const temp_mos1 = ModbusClient.bufferToInt16(Buffer.concat(reg_temp_mos1)) * 0.1;
      this.setCapabilityValue('measure_temperature.mos1', temp_mos1).catch(this.error);

      const reg_temp_mos2 = await this.modbus.readHoldingRegisters(slaveId, 35002, 1);
      const temp_mos2 = ModbusClient.bufferToInt16(Buffer.concat(reg_temp_mos2)) * 0.1;
      this.setCapabilityValue('measure_temperature.mos2', temp_mos2).catch(this.error);

      await this.processAlarmCodes(slaveId);
    } catch (error) {
      this.log('Error processing battery health:', error);
    }
  }

  async processAlarmCodes(slaveId) {
    // Reads Marstek fault registers 36000/36100/36101 and drives the
    // alarm_generic capability plus the venusd_* fault flow triggers.
    //
    // 36103 is deliberately NOT read here - see the top-of-file comment
    // for the tester-dump findings that led to that decision. Adding it
    // would reintroduce the constant false hardware-alarm flood on
    // firmware v149.
    try {
      const alarms = [];
      const systemAlarms = [];
      const gridAlarms = [];
      const batteryAlarms = [];
      let hasAlarm = false;

      let alarm_code = 0;
      let grid_fault = 0;
      let battery_fault = 0;

      try {
        const reg_alarm_code = await this.modbus.readHoldingRegisters(slaveId, 36000, 1);
        alarm_code = ModbusClient.bufferToUint16(Buffer.concat(reg_alarm_code));
        if (alarm_code > 0) {
          hasAlarm = true;
          if (alarm_code & 0x01) { alarms.push('PLL Abnormal Restart'); systemAlarms.push('PLL Abnormal Restart'); }
          if (alarm_code & 0x02) { alarms.push('Over Temperature Limit'); systemAlarms.push('Over Temperature Limit'); }
          if (alarm_code & 0x04) { alarms.push('Low Temperature Limit'); systemAlarms.push('Low Temperature Limit'); }
          if (alarm_code & 0x08) { alarms.push('Fan Abnormal Warning'); systemAlarms.push('Fan Abnormal Warning'); }
          if (alarm_code & 0x10) { alarms.push('Low Battery SOC Warning'); systemAlarms.push('Low Battery SOC Warning'); }
          if (alarm_code & 0x20) { alarms.push('Output Overcurrent Warning'); systemAlarms.push('Output Overcurrent Warning'); }
          if (alarm_code & 0x40) { alarms.push('Abnormal Line Sequence Detection'); systemAlarms.push('Abnormal Line Sequence Detection'); }
        }
      } catch (e) {
        this.log(`Alarm register 36000 not available: ${e.message}`);
      }

      try {
        const reg_grid_fault = await this.modbus.readHoldingRegisters(slaveId, 36100, 1);
        grid_fault = ModbusClient.bufferToUint16(Buffer.concat(reg_grid_fault));
        if (grid_fault > 0) {
          hasAlarm = true;
          if (grid_fault & 0x01) { alarms.push('Grid Overvoltage'); gridAlarms.push('Grid Overvoltage'); }
          if (grid_fault & 0x02) { alarms.push('Grid Undervoltage'); gridAlarms.push('Grid Undervoltage'); }
          if (grid_fault & 0x04) { alarms.push('Grid Overfrequency'); gridAlarms.push('Grid Overfrequency'); }
          if (grid_fault & 0x08) { alarms.push('Grid Underfrequency'); gridAlarms.push('Grid Underfrequency'); }
          if (grid_fault & 0x10) { alarms.push('Grid Peak Voltage Abnormal'); gridAlarms.push('Grid Peak Voltage Abnormal'); }
          if (grid_fault & 0x20) { alarms.push('Current Dcover'); gridAlarms.push('Current Dcover'); }
          if (grid_fault & 0x40) { alarms.push('Voltage Dcover'); gridAlarms.push('Voltage Dcover'); }
        }
      } catch (e) {
        this.log(`Grid fault register 36100 not available: ${e.message}`);
      }

      try {
        const reg_battery_fault = await this.modbus.readHoldingRegisters(slaveId, 36101, 1);
        battery_fault = ModbusClient.bufferToUint16(Buffer.concat(reg_battery_fault));
        if (battery_fault > 0) {
          hasAlarm = true;
          if (battery_fault & 0x01) { alarms.push('Battery Overvoltage'); batteryAlarms.push('Battery Overvoltage'); }
          if (battery_fault & 0x02) { alarms.push('Battery Undervoltage'); batteryAlarms.push('Battery Undervoltage'); }
          if (battery_fault & 0x04) { alarms.push('Battery Overcurrent'); batteryAlarms.push('Battery Overcurrent'); }
          if (battery_fault & 0x08) { alarms.push('Battery Low SOC'); batteryAlarms.push('Battery Low SOC'); }
          if (battery_fault & 0x10) { alarms.push('Battery Communication Failure'); batteryAlarms.push('Battery Communication Failure'); }
          if (battery_fault & 0x20) { alarms.push('BMS Protect'); batteryAlarms.push('BMS Protect'); }
        }
      } catch (e) {
        this.log(`Battery fault register 36101 not available: ${e.message}`);
      }

      const alarmPolicy = this.getSetting('show_alarms') || 'auto';
      const showAlarms = alarmPolicy !== 'never';

      const effectiveAlarm = showAlarms && hasAlarm;
      const currentAlarm = this.getCapabilityValue('alarm_generic');
      if (currentAlarm !== effectiveAlarm) {
        this.setCapabilityValue('alarm_generic', effectiveAlarm).catch(this.error);
      }

      if (hasAlarm && alarms.length > 0) {
        const diagMessage = `Device alarms detected: ${alarms.join(', ')}`;
        this.log(`Alarms detected: ${diagMessage}${showAlarms ? '' : ' (suppressed by show_alarms=never)'}`);
      }

      if (showAlarms && hasAlarm && alarms.length > 0) {
        const alarmMessage = `Device alarms detected: ${alarms.join(', ')}`;
        const alarmCodes = `System:${alarm_code},Grid:${grid_fault},Battery:${battery_fault}`;

        this.setWarning(alarmMessage);

        this.homey.flow.getDeviceTriggerCard('venusd_battery_fault_detected')
          .trigger(this, { message: alarmMessage, alarm_codes: alarmCodes }, {})
          .catch(this.error);

        if (gridAlarms.length > 0) {
          this.homey.flow.getDeviceTriggerCard('venusd_grid_fault_detected')
            .trigger(this, { message: gridAlarms.join(', ') }, {})
            .catch(this.error);
        }
        if (batteryAlarms.length > 0) {
          this.homey.flow.getDeviceTriggerCard('venusd_battery_system_fault_detected')
            .trigger(this, { message: batteryAlarms.join(', ') }, {})
            .catch(this.error);
        }
        if (systemAlarms.length > 0) {
          this.homey.flow.getDeviceTriggerCard('venusd_battery_warning_detected')
            .trigger(this, { message: systemAlarms.join(', '), alarm_codes: alarmCodes }, {})
            .catch(this.error);
        }
      } else {
        this.unsetWarning();
      }
    } catch (error) {
      this.log('Error processing alarm codes:', error);
    }
  }

  async processSystemData(slaveId) {
    try {
      // Total charge energy (u32 * 0.01 kWh)
      const reg_total_charge_energy = await this.modbus.readHoldingRegisters(slaveId, 33000, 2);
      const total_charge_energy = ModbusClient.bufferToUint32(Buffer.concat(reg_total_charge_energy)) * 0.01;
      this.setCapabilityValue('meter_power.imported', total_charge_energy).catch(this.error);

      const reg_total_discharge_energy = await this.modbus.readHoldingRegisters(slaveId, 33002, 2);
      const total_discharge_energy = ModbusClient.bufferToInt32(Buffer.concat(reg_total_discharge_energy)) * 0.01;
      this.setCapabilityValue('meter_power.exported', total_discharge_energy).catch(this.error);

      // Inverter state
      const reg_inverter_state = await this.modbus.readHoldingRegisters(slaveId, 35100, 1);
      const inverter_state = ModbusClient.bufferToUint16(Buffer.concat(reg_inverter_state));
      const modeStr = this.driver.INVERTER_MODES[inverter_state];
      const previousMode = this.getCapabilityValue('operation_mode');
      if (modeStr === undefined) {
        this.log(`Unknown inverter state ${inverter_state} - not updating operation_mode`);
      } else if (previousMode !== modeStr) {
        this.setCapabilityValue('operation_mode', modeStr).catch(this.error);
        if (previousMode) {
          this.homey.flow.getDeviceTriggerCard('venusd_operation_mode_changed')
            .trigger(this, { mode: modeStr, prevMode: previousMode })
            .catch(this.error);
        }
      }

      // Force mode
      const reg_force_mode = await this.modbus.readHoldingRegisters(slaveId, 42010, 1);
      const force_mode = ModbusClient.bufferToUint16(Buffer.concat(reg_force_mode));
      const forceModeStr = this.driver.FORCE_MODES[force_mode];

      const currentForceMode = this.getCapabilityValue('force_charge_mode');
      let displayForceMode = forceModeStr;
      if (currentForceMode === 'target_power' && (forceModeStr === 'force_charge' || forceModeStr === 'force_discharge')) {
        displayForceMode = 'target_power';
      }
      if (forceModeStr === undefined) {
        this.log(`Unknown force mode ${force_mode} - not updating force_charge_mode`);
      } else if (currentForceMode === 'force_soc' && forceModeStr === 'none') {
        // force_soc is Homey-only; keep the label sticky
      } else if (currentForceMode !== displayForceMode) {
        this.setCapabilityValue('force_charge_mode', displayForceMode).catch(this.error);
      }

      // Work mode - if RS485 control gate (42000) is open (0x55AA / 21930),
      // effective work mode is control_mode (3) regardless of 43000.
      const reg_work_mode = await this.modbus.readHoldingRegisters(slaveId, 43000, 1);
      let work_mode = ModbusClient.bufferToUint16(Buffer.concat(reg_work_mode));
      const reg_force_mode_state = await this.modbus.readHoldingRegisters(slaveId, 42000, 1);
      const force_mode_state = ModbusClient.bufferToUint16(Buffer.concat(reg_force_mode_state));
      if (force_mode_state == 21930) work_mode = 3;
      const workModeStr = this.driver.WORK_MODES[work_mode];

      if (workModeStr === undefined) {
        this.log(`Unknown work mode ${work_mode} - not updating user_work_mode`);
      } else {
        const currentWorkMode = this.getCapabilityValue('user_work_mode');
        if (currentWorkMode !== workModeStr) {
          this.setCapabilityValue('user_work_mode', workModeStr).catch(this.error);
        }
      }
      this.processChargingStatus(modeStr);

      // Force SOC target
      const reg_force_soc = await this.modbus.readHoldingRegisters(slaveId, 42011, 1);
      const force_soc = ModbusClient.bufferToUint16(Buffer.concat(reg_force_soc));
      const currentForceTarget = this.getCapabilityValue('force_charge_target');
      if (currentForceTarget !== force_soc) {
        this.setCapabilityValue('force_charge_target', force_soc).catch(this.error);
      }

      // Backup mode (register 41200: 0=enabled, 1=disabled)
      const reg_backup_mode = await this.modbus.readHoldingRegisters(slaveId, 41200, 1);
      const backup_mode = ModbusClient.bufferToUint16(Buffer.concat(reg_backup_mode));
      const backupModeValue = (backup_mode == 0);
      const currentBackupMode = this.getCapabilityValue('backup_mode');
      if (currentBackupMode !== backupModeValue) {
        this.setCapabilityValue('backup_mode', backupModeValue).catch(this.error);
      }

      // Max charge/discharge power limits
      const reg_max_charge_power = await this.modbus.readHoldingRegisters(slaveId, 44002, 1);
      const max_charge_power = ModbusClient.bufferToUint16(Buffer.concat(reg_max_charge_power));
      const currentMaxChargePower = this.getCapabilityValue('max_charge_power_limit');
      if (currentMaxChargePower !== max_charge_power) {
        this.setCapabilityValue('max_charge_power_limit', max_charge_power).catch(this.error);
      }
      const reg_max_discharge_power = await this.modbus.readHoldingRegisters(slaveId, 44003, 1);
      const max_discharge_power = ModbusClient.bufferToUint16(Buffer.concat(reg_max_discharge_power));
      const currentMaxDischargePower = this.getCapabilityValue('max_discharge_power_limit');
      if (currentMaxDischargePower !== max_discharge_power) {
        this.setCapabilityValue('max_discharge_power_limit', max_discharge_power).catch(this.error);
      }

      // Sync target_power slider range to hardware ceiling
      const targetMax = max_charge_power > 0 ? max_charge_power : 2500;
      const targetMin = -(max_discharge_power > 0 ? max_discharge_power : 2500);
      if (this._targetPowerMax !== targetMax || this._targetPowerMin !== targetMin) {
        try {
          await this.setCapabilityOptions('target_power', {
            min: targetMin,
            max: targetMax,
            step: 5,
          });
          this._targetPowerMin = targetMin;
          this._targetPowerMax = targetMax;
          this.log(`target_power range updated to [${targetMin}, ${targetMax}] W`);
        } catch (err) {
          this.log('Failed to update target_power range:', err.message);
        }
      }

      // Derive target_power from force registers
      let derivedTargetPower = 0;
      if (forceModeStr === 'force_charge') {
        derivedTargetPower = this.getCapabilityValue('force_charge_power') || 0;
      } else if (forceModeStr === 'force_discharge') {
        derivedTargetPower = -(this.getCapabilityValue('force_discharge_power') || 0);
      }
      const currentTargetPower = this.getCapabilityValue('target_power');
      if (currentTargetPower !== derivedTargetPower) {
        this.setCapabilityValue('target_power', derivedTargetPower).catch(this.error);
      }

      // target_power_mode mirrors user_work_mode with control_mode -> homey
      const derivedTargetMode = (workModeStr === 'control_mode') ? 'homey' : workModeStr;
      const currentTargetMode = this.getCapabilityValue('target_power_mode');
      if (derivedTargetMode && currentTargetMode !== derivedTargetMode) {
        this.setCapabilityValue('target_power_mode', derivedTargetMode).catch(this.error);
      }

      // onoff derivation - same as Venus E
      const forceSocActive = displayForceMode === 'force_soc';
      const derivedOnOff = !(derivedTargetMode === 'homey' && derivedTargetPower === 0 && !forceSocActive);
      const currentOnOff = this.getCapabilityValue('onoff');
      if (currentOnOff !== derivedOnOff) {
        this.setCapabilityValue('onoff', derivedOnOff).catch(this.error);
      }
      if (derivedOnOff) {
        const activeMode = derivedTargetMode || 'anti_feed';
        if (this.getStoreValue('lastActiveMode') !== activeMode) {
          this.setStoreValue('lastActiveMode', activeMode).catch(this.error);
        }
        if (activeMode === 'homey' && derivedTargetPower !== 0) {
          this.setStoreValue('lastActivePower', derivedTargetPower).catch(this.error);
        }
      }
    } catch (error) {
      this.log('Error processing system data:', error);
    }
  }

  processChargingStatus(operationMode) {
    let chargingStatus = 'idle';
    if (operationMode && operationMode.toLowerCase().includes('discharge')) {
      chargingStatus = 'discharging';
    } else if (operationMode && operationMode.toLowerCase().includes('charge')) {
      chargingStatus = 'charging';
    }
    const previousStatus = this.getCapabilityValue('battery_charging_state');
    if (previousStatus !== chargingStatus) {
      this.setCapabilityValue('battery_charging_state', chargingStatus).catch(this.error);
      this.homey.flow.getDeviceTriggerCard('venusd_charging_status_changed')
        .trigger(this, { status: chargingStatus }, { status: chargingStatus })
        .catch(this.error);
      if (chargingStatus === 'charging') {
        this.homey.flow.getDeviceTriggerCard('venusd_battery_started_charging')
          .trigger(this, {}, {})
          .catch(this.error);
      } else if (chargingStatus === 'discharging') {
        this.homey.flow.getDeviceTriggerCard('venusd_battery_started_discharging')
          .trigger(this, {}, {})
          .catch(this.error);
      }
    }
  }

  triggerSOCEvents(soc) {
    const previousSOC = this.previousValues.soc;
    if (previousSOC !== undefined) {
      const thresholds = [10, 20, 50, 80, 90];
      thresholds.forEach(threshold => {
        if (previousSOC > threshold && soc <= threshold) {
          this.homey.flow.getDeviceTriggerCard('venusd_soc_below_threshold')
            .trigger(this, { threshold }, { threshold })
            .catch(this.error);
        } else if (previousSOC < threshold && soc >= threshold) {
          this.homey.flow.getDeviceTriggerCard('venusd_soc_above_threshold')
            .trigger(this, { threshold }, { threshold })
            .catch(this.error);
        }
      });
    }
    this.previousValues.soc = soc;
  }

  triggerTemperatureEvents(temperature) {
    const previousTemp = this.previousValues.temperature;
    if (previousTemp !== undefined) {
      const highTemp = 50;
      const lowTemp = -10;
      if (previousTemp < highTemp && temperature >= highTemp) {
        this.homey.flow.getDeviceTriggerCard('venusd_temperature_too_high')
          .trigger(this, { temperature }, {})
          .catch(this.error);
      }
      if (previousTemp > lowTemp && temperature <= lowTemp) {
        this.homey.flow.getDeviceTriggerCard('venusd_temperature_too_low')
          .trigger(this, { temperature }, {})
          .catch(this.error);
      }
    }
    this.previousValues.temperature = temperature;
  }

  // Write handlers - same logic as Venus E

  async onCapabilityBackupMode(value, opts = {}) {
    try {
      if (!await this.connectModbus()) throw new Error('Modbus connection failed');
      const slaveId = this.settings.slave_id || 1;
      await this.modbus.writeSingleRegister(slaveId, 41200, (value ? 0 : 1));
      this.log('Backup mode set to: ' + value);
      await this.setCapabilityValue('backup_mode', value);
      if (this.backupModeChangedTrigger && !opts.fromCloudSync) {
        await this.backupModeChangedTrigger.trigger(this,
          { mode: value },
          { mode: value.toString() }
        );
      }
    } catch (error) {
      this.log('Error setting backup mode:', error);
      throw new Error('Failed to backup mode');
    }
  }

  async onCapabilityForceChargePower(value, opts = {}) {
    try {
      if (!await this.connectModbus()) throw new Error('Modbus connection failed');
      const slaveId = this.settings.slave_id || 1;
      await this.modbus.writeSingleRegister(slaveId, 42020, Math.round(value));
      this.log('Force charge power set to: ' + value);
      await this.setCapabilityValue('force_charge_power', Math.round(value));
      if (this.forceChargePowerChangedTrigger && !opts.fromCloudSync) {
        await this.forceChargePowerChangedTrigger.trigger(this,
          { power: value },
          { power: value }
        );
      }
    } catch (error) {
      this.log('Error setting force charge power:', error);
      throw new Error('Failed to set force charge power');
    }
  }

  async onCapabilityForceDisChargePower(value, opts = {}) {
    try {
      if (!await this.connectModbus()) throw new Error('Modbus connection failed');
      const slaveId = this.settings.slave_id || 1;
      await this.modbus.writeSingleRegister(slaveId, 42021, Math.round(value));
      this.log('Force discharge power set to: ' + value);
      await this.setCapabilityValue('force_discharge_power', Math.round(value));
      if (this.forceDischargePowerChangedTrigger && !opts.fromCloudSync) {
        await this.forceDischargePowerChangedTrigger.trigger(this,
          { power: value },
          { power: value }
        );
      }
    } catch (error) {
      this.log('Error setting force discharge power:', error);
      throw new Error('Failed to set force discharge power');
    }
  }

  async onCapabilityChargeMode(value, opts = {}) {
    try {
      if (!await this.connectModbus()) throw new Error('Modbus connection failed');

      const wantsHomeyControl = value === 'force_charge' || value === 'force_discharge'
        || value === 'force_soc' || value === 'target_power';
      if (wantsHomeyControl && this.getCapabilityValue('target_power_mode') !== 'homey') {
        this.log(`force_charge_mode=${value} requested while not in homey mode - switching`);
        await this.onCapabilityTargetPowerMode('homey');
      }

      const slaveId = this.settings.slave_id || 1;

      if (value === 'force_soc') {
        this.log('Force SOC mode selected - writing current SOC target to register 42011');
        const currentTarget = this.getCapabilityValue('force_charge_target') || 25;
        await this.modbus.writeSingleRegister(slaveId, 42011, currentTarget);
        await this.setCapabilityValue('onoff', true).catch(this.error);
        await this.setStoreValue('lastActiveMode', 'homey');
      } else if (value === 'target_power') {
        const currentTargetPower = this.getCapabilityValue('target_power') || 0;
        this.log(`target_power mode selected via picker - re-applying ${currentTargetPower}W`);
        await this.onCapabilityTargetPower(currentTargetPower, { fromCloudSync: true });
      } else {
        const modeValue = Object.keys(this.driver.FORCE_MODES).find(
          key => this.driver.FORCE_MODES[key] === value
        );
        await this.modbus.writeSingleRegister(slaveId, 42010, parseInt(modeValue));
      }
      this.log('Charge mode set to:', value);

      const delay = this.settings.force_mode_delay || 1000;
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      await this.setCapabilityValue('force_charge_mode', value);
      if (this.forceChargeModeChangedTrigger && !opts.fromCloudSync) {
        await this.forceChargeModeChangedTrigger.trigger(this,
          { mode: value },
          { mode: value }
        );
      }
    } catch (error) {
      this.log('Error setting charge mode:', error);
      throw new Error('Failed to set charge mode');
    }
  }

  async onCapabilityUserWorkMode(value, opts = {}) {
    try {
      if (this.getCapabilityValue('user_work_mode') === value) {
        this.log(`user_work_mode already ${value}, skipping redundant write`);
        return;
      }
      if (!await this.connectModbus()) throw new Error('Modbus connection failed');

      const slaveId = this.settings.slave_id || 1;
      const userWorkValue = Object.keys(this.driver.WORK_MODES).find(
        key => this.driver.WORK_MODES[key] === value
      );

      if (userWorkValue == 3) {
        this.log('Enabling RS485 control mode (42000 = 0x55AA)');
        await this.modbus.writeSingleRegister(slaveId, 42000, 21930);
      } else {
        this.log('Disabling RS485 control mode');
        await this.setCapabilityValue('force_charge_mode', 'none');
        await this.modbus.writeSingleRegister(slaveId, 42000, 21947);
        await this.modbus.writeSingleRegister(slaveId, 43000, userWorkValue);
      }

      this.log('Work mode set to: ' + value);
      await this.setCapabilityValue('user_work_mode', value);
      const mirrored = (value === 'control_mode') ? 'homey' : value;
      await this.setCapabilityValue('target_power_mode', mirrored).catch(this.error);

      if (this.userWorkModeChangedTrigger && !opts.fromCloudSync) {
        await this.userWorkModeChangedTrigger.trigger(this,
          { mode: value },
          { mode: value }
        );
      }
    } catch (error) {
      this.log('Error setting work mode:', error);
      throw new Error('Failed to set work mode');
    }
  }

  async onCapabilityOnoff(value, opts = {}) {
    try {
      if (this.getCapabilityValue('onoff') === value) {
        this.log(`onoff already ${value}, skipping redundant write`);
        return;
      }
      if (value === false) {
        await this.onCapabilityTargetPowerMode('homey');
        await this.onCapabilityTargetPower(0);
      } else {
        const lastActive = this.getStoreValue('lastActiveMode') || 'anti_feed';
        if (lastActive === 'homey') {
          const lastPower = this.getStoreValue('lastActivePower') || 0;
          await this.onCapabilityTargetPowerMode('homey');
          if (lastPower !== 0) {
            await this.onCapabilityTargetPower(lastPower);
          }
        } else {
          await this.onCapabilityTargetPowerMode(lastActive);
        }
      }
      await this.setCapabilityValue('onoff', value).catch(this.error);
      this.log(`onoff set to ${value}`);
    } catch (error) {
      this.log('Error setting onoff:', error);
      throw new Error('Failed to set onoff');
    }
  }

  async onCapabilityTargetPower(value, opts = {}) {
    try {
      const slaveId = this.settings.slave_id || 1;
      const power = Math.round(Number(value) || 0);

      if (this.getCapabilityValue('target_power') === power) {
        this.log(`target_power already ${power}W, skipping redundant write`);
        return;
      }

      if (!await this.connectModbus()) throw new Error('Modbus connection failed');

      if (this.getCapabilityValue('user_work_mode') !== 'control_mode') {
        this.log('target_power requested while not in control_mode - enabling RS485 control');
        await this.modbus.writeSingleRegister(slaveId, 42000, 21930);
        await this.setCapabilityValue('user_work_mode', 'control_mode').catch(this.error);
      }

      // Neutralize any active force_soc target - see Venus E for rationale.
      const previousForceMode = this.getCapabilityValue('force_charge_mode');
      const currentSocTarget = this.getCapabilityValue('force_charge_target');
      const currentSoc = this.getCapabilityValue('measure_battery');
      const socTargetDrift = typeof currentSocTarget === 'number'
        && typeof currentSoc === 'number'
        && Math.abs(currentSocTarget - currentSoc) > 1;
      if ((previousForceMode === 'force_soc' || socTargetDrift)
          && typeof currentSoc === 'number' && currentSoc > 0) {
        const clampedSoc = Math.max(11, Math.min(100, Math.round(currentSoc)));
        await this.modbus.writeSingleRegister(slaveId, 42011, clampedSoc);
        this.log(`Neutralized force_soc by writing current SOC (${clampedSoc}%) to 42011`);
      }

      const prevReg42010 = (previousForceMode === 'force_charge')
        ? 1
        : (previousForceMode === 'force_discharge')
          ? 2
          : (previousForceMode === 'target_power')
            ? ((this.getCapabilityValue('target_power') || 0) >= 0 ? 1 : 2)
            : 0;
      const newReg42010 = power > 0 ? 1 : (power < 0 ? 2 : 0);

      let newForceMode = 'none';
      if (power > 0) {
        const charge = Math.min(2500, power);
        await this.modbus.writeSingleRegister(slaveId, 42020, charge);
        newForceMode = 'target_power';
        await this.setCapabilityValue('force_charge_power', charge).catch(this.error);
      } else if (power < 0) {
        const discharge = Math.min(2500, Math.abs(power));
        await this.modbus.writeSingleRegister(slaveId, 42021, discharge);
        newForceMode = 'target_power';
        await this.setCapabilityValue('force_discharge_power', discharge).catch(this.error);
      }
      if (newReg42010 !== prevReg42010) {
        await this.modbus.writeSingleRegister(slaveId, 42010, newReg42010);
        const delay = this.settings.force_mode_delay || 1000;
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      await this.setCapabilityValue('force_charge_mode', newForceMode).catch(this.error);
      await this.setCapabilityValue('target_power', power).catch(this.error);
      await this.setCapabilityValue('target_power_mode', 'homey').catch(this.error);

      if (power !== 0) {
        await this.setCapabilityValue('onoff', true).catch(this.error);
        await this.setStoreValue('lastActiveMode', 'homey');
        await this.setStoreValue('lastActivePower', power);
      } else {
        await this.setCapabilityValue('onoff', false).catch(this.error);
      }
      this.log(`target_power set to ${power}W (mode=${newForceMode})`);
    } catch (error) {
      this.log('Error setting target_power:', error);
      throw new Error('Failed to set target_power');
    }
  }

  async onCapabilityTargetPowerMode(value, opts = {}) {
    try {
      if (this.getCapabilityValue('target_power_mode') === value) {
        this.log(`target_power_mode already ${value}, skipping redundant write`);
        return;
      }
      const workModeByTargetMode = {
        homey: 'control_mode',
        manual: 'manual',
        anti_feed: 'anti_feed',
        trade_mode: 'trade_mode',
      };
      const targetWorkMode = workModeByTargetMode[value];
      if (!targetWorkMode) {
        throw new Error(`Unsupported target_power_mode: ${value}`);
      }
      await this.onCapabilityUserWorkMode(targetWorkMode);
      if (value !== 'homey') {
        await this.setCapabilityValue('target_power', 0).catch(this.error);
      }
      await this.setCapabilityValue('target_power_mode', value).catch(this.error);
      if (value !== 'homey') {
        await this.setCapabilityValue('onoff', true).catch(this.error);
        await this.setStoreValue('lastActiveMode', value);
      } else if ((this.getCapabilityValue('target_power') || 0) === 0) {
        await this.setCapabilityValue('onoff', false).catch(this.error);
      }
      this.log(`target_power_mode set to ${value}`);
    } catch (error) {
      this.log('Error setting target_power_mode:', error);
      throw new Error('Failed to set target_power_mode');
    }
  }

  async onCapabilityForceChargeTarget(value, opts = {}) {
    try {
      if (!await this.connectModbus()) throw new Error('Modbus connection failed');
      if (this.getCapabilityValue('target_power_mode') !== 'homey') {
        this.log('force_charge_target changed while not in homey mode - switching');
        await this.onCapabilityTargetPowerMode('homey');
      }
      const slaveId = this.settings.slave_id || 1;
      await this.setCapabilityValue('force_charge_mode', 'force_soc');
      await this.modbus.writeSingleRegister(slaveId, 42011, value);
      this.log('Set the force SOC target to ' + value);
      await this.setCapabilityValue('force_charge_target', value);
      await this.setCapabilityValue('onoff', true).catch(this.error);
      await this.setStoreValue('lastActiveMode', 'homey');
      if (this.forceChargeTargetChangedTrigger && !opts.fromCloudSync) {
        await this.forceChargeTargetChangedTrigger.trigger(this,
          { target: value },
          { target: value }
        );
      }
    } catch (error) {
      this.log('Error setting force SOC target:', error);
      throw new Error('Failed to force SOC target');
    }
  }

  async setChargingCutoffSoc(percentage) {
    try {
      if (!await this.connectModbus()) throw new Error('Modbus connection failed');
      const clampedPercentage = Math.min(100, Math.max(40, percentage));
      if (clampedPercentage !== percentage) {
        this.log(`Charging cutoff SOC ${percentage}% clamped to ${clampedPercentage}%`);
      }
      const slaveId = this.settings.slave_id || 1;
      const registerValue = Math.round(clampedPercentage * 10);
      await this.modbus.writeSingleRegister(slaveId, 42000, 21930);
      await this.modbus.writeSingleRegister(slaveId, 44000, registerValue);
      this.log('Charging cutoff SOC written successfully');
    } catch (error) {
      this.error('Error writing charging cutoff SOC:', error);
      throw error;
    }
  }

  async setDischargingCutoffSoc(percentage) {
    try {
      if (!await this.connectModbus()) throw new Error('Modbus connection failed');
      const clampedPercentage = Math.min(30, Math.max(12, percentage));
      if (clampedPercentage !== percentage) {
        this.log(`Discharging cutoff SOC ${percentage}% clamped to ${clampedPercentage}%`);
      }
      const slaveId = this.settings.slave_id || 1;
      const registerValue = Math.round(clampedPercentage * 10);
      await this.modbus.writeSingleRegister(slaveId, 42000, 21930);
      await this.modbus.writeSingleRegister(slaveId, 44001, registerValue);
      this.log('Discharging cutoff SOC written successfully');
    } catch (error) {
      this.error('Error writing discharging cutoff SOC:', error);
      throw error;
    }
  }

  // Flow card condition handlers

  async conditionIsCharging() {
    const status = this.getCapabilityValue('battery_charging_state');
    return status === 'charging';
  }
  async conditionIsDischarging() {
    const status = this.getCapabilityValue('battery_charging_state');
    return status === 'discharging';
  }
  async conditionSOCAbove(args) {
    const soc = this.getCapabilityValue('measure_battery');
    return soc > args.percentage;
  }
  async conditionSOCBelow(args) {
    const soc = this.getCapabilityValue('measure_battery');
    return soc < args.percentage;
  }
  async conditionOperationModeIs(args) {
    return this.getCapabilityValue('operation_mode') === args.mode;
  }
  async conditionHasFault() {
    return this.getCapabilityValue('alarm_generic') === true;
  }
  async conditionTemperatureAbove(args) {
    return this.getCapabilityValue('measure_temperature') > args.temperature;
  }
  async conditionBackupModeIs(args) {
    const currentMode = this.getCapabilityValue('backup_mode');
    return currentMode === (args.mode === 'true');
  }
  async conditionForceChargeModeIs(args) {
    return this.getCapabilityValue('force_charge_mode') === args.mode;
  }
  async conditionUserWorkModeIs(args) {
    return this.getCapabilityValue('user_work_mode') === args.mode;
  }
  async conditionForceChargePowerGreaterThan(args) {
    return (this.getCapabilityValue('force_charge_power') || 0) > Number(args.power);
  }
  async conditionForceDischargePowerGreaterThan(args) {
    return (this.getCapabilityValue('force_discharge_power') || 0) > Number(args.power);
  }
  async conditionForceChargeTargetGreaterThan(args) {
    return (this.getCapabilityValue('force_charge_target') || 0) > Number(args.target);
  }
  async conditionMaxChargePowerLimitBelow(args) {
    return (this.getCapabilityValue('max_charge_power_limit') || 0) < Number(args.power);
  }
  async conditionMaxDischargePowerLimitBelow(args) {
    return (this.getCapabilityValue('max_discharge_power_limit') || 0) < Number(args.power);
  }
  async conditionChargingCutoffSocAbove(args) {
    return (this.getSetting('charging_cutoff_soc') || 100) > Number(args.percentage);
  }
  async conditionDischargingCutoffSocAbove(args) {
    return (this.getSetting('discharging_cutoff_soc') || 15) > Number(args.percentage);
  }

  // Flow card action handlers
  async actionSetChargeMode(args) {
    await this.onCapabilityChargeMode(args.mode);
    return true;
  }
  async actionSetBackupMode(args) {
    await this.onCapabilityBackupMode(args.mode === 'true');
    return true;
  }
  async actionSetForceChargeMode(args) {
    await this.onCapabilityChargeMode(args.mode);
    return true;
  }
  async actionSetUserWorkMode(args) {
    await this.onCapabilityUserWorkMode(args.mode);
    return true;
  }
  async actionSetForceChargePower(args) {
    const power = Number(args.power);
    if (power < 0 || power > 2500) {
      throw new Error(`Invalid power value: ${power}W. Must be between 0-2500W`);
    }
    await this.onCapabilityForceChargePower(power);
    return true;
  }
  async actionSetForceDischargePower(args) {
    const power = Number(args.power);
    if (power < 0 || power > 2500) {
      throw new Error(`Invalid power value: ${power}W. Must be between 0-2500W`);
    }
    await this.onCapabilityForceDisChargePower(power);
    return true;
  }
  async actionSetForceChargeTarget(args) {
    const target = Number(args.target);
    if (target < 11 || target > 100) {
      throw new Error(`Invalid SOC target: ${target}%. Must be between 11-100%`);
    }
    await this.onCapabilityForceChargeTarget(target);
    return true;
  }
  async actionSetChargingCutoffSoc(args) {
    const percentage = Number(args.percentage);
    if (percentage < 40 || percentage > 100) {
      throw new Error(`Invalid charging cutoff SOC: ${percentage}%. Must be between 40-100%`);
    }
    await this.setChargingCutoffSoc(percentage);
    await this.setSettings({ 'charging_cutoff_soc': percentage });
    return true;
  }
  async actionSetDischargingCutoffSoc(args) {
    const percentage = Number(args.percentage);
    if (percentage < 12 || percentage > 30) {
      throw new Error(`Invalid discharging cutoff SOC: ${percentage}%. Must be between 12-30%`);
    }
    await this.setDischargingCutoffSoc(percentage);
    await this.setSettings({ 'discharging_cutoff_soc': percentage });
    return true;
  }

  registerFlowCardTriggers() {
    this.forceChargeModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('venusd_force_charge_mode_changed');
    this.operationModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('venusd_operation_mode_changed');
    this.userWorkModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('venusd_user_work_mode_changed');
    this.forceChargePowerChangedTrigger = this.homey.flow.getDeviceTriggerCard('venusd_force_charge_power_changed');
    this.forceDischargePowerChangedTrigger = this.homey.flow.getDeviceTriggerCard('venusd_force_discharge_power_changed');
    this.forceChargeTargetChangedTrigger = this.homey.flow.getDeviceTriggerCard('venusd_force_charge_target_changed');
    this.backupModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('venusd_backup_mode_changed');
    this.log('Flow card triggers registered');
  }

  setupCapabilityListeners() {
    this.registerCapabilityListener('backup_mode', this.onCapabilityBackupMode.bind(this));
    this.registerCapabilityListener('force_charge_mode', this.onCapabilityChargeMode.bind(this));
    this.registerCapabilityListener('user_work_mode', this.onCapabilityUserWorkMode.bind(this));
    this.registerCapabilityListener('force_charge_power', this.onCapabilityForceChargePower.bind(this));
    this.registerCapabilityListener('force_discharge_power', this.onCapabilityForceDisChargePower.bind(this));
    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('force_charge_target', this.onCapabilityForceChargeTarget.bind(this));
    this.registerMultipleCapabilityListener(
      ['target_power', 'target_power_mode'],
      async (values) => {
        if (values.target_power_mode !== undefined) {
          await this.onCapabilityTargetPowerMode(values.target_power_mode);
        }
        if (values.target_power !== undefined) {
          await this.onCapabilityTargetPower(values.target_power);
        }
      },
      500
    );
    this.registerCapabilityListener('operation_mode', async (value, opts) => {
      this.log(`Operation mode changed to: ${value}`);
      if (this.operationModeChangedTrigger && !opts.fromCloudSync) {
        await this.operationModeChangedTrigger.trigger(this,
          { mode: value },
          { mode: value }
        );
      }
    });
    this.log('Capability listeners registered');
  }

  async onDeleted() {
    this.log('VenusDDevice deleted');
    this._isDeleted = true;
    this.stopPolling();
    this.disconnectModbus();
  }
}

module.exports = VenusDDevice;
