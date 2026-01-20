'use strict';

const Homey = require('homey');
const ModbusClient = require('./api/ModbusClient');

module.exports = class MyMarstekBatteryApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MyMarstekBatteryApp has been initialized');

    // Create a dedicated Modbus client for testing
    this.testModbus = new ModbusClient();
  }

  /**
   * Get all Venus battery devices
   * Used by the settings page to list available devices
   */
  getVenusDevices() {
    const driver = this.homey.drivers.getDriver('venus');
    if (!driver) {
      return [];
    }

    const devices = driver.getDevices();
    return devices.map(device => ({
      id: device.getData().id,
      name: device.getName(),
      ip: device.getSetting('ip'),
      port: device.getSetting('port'),
      slaveId: device.getSetting('slave_id')
    }));
  }

  /**
   * Get a Venus device by its ID
   */
  getVenusDeviceById(deviceId) {
    const driver = this.homey.drivers.getDriver('venus');
    if (!driver) {
      return null;
    }

    const devices = driver.getDevices();
    return devices.find(device => device.getData().id === deviceId);
  }

  /**
   * Read a Modbus register from a device
   * @param {string} deviceId - The device ID
   * @param {number} address - The register address
   * @param {number} count - Number of registers to read (default 1)
   */
  async readRegister(deviceId, address, count = 1) {
    const device = this.getVenusDeviceById(deviceId);
    if (!device) {
      throw new Error('Device not found');
    }

    const settings = device.getSettings();
    const ip = settings.ip;
    const port = settings.port || 502;
    const slaveId = settings.slave_id || 1;

    try {
      // Connect to the device
      await this.testModbus.connect({ ip, port });

      // Read the register(s)
      const result = await this.testModbus.readHoldingRegisters(slaveId, address, count);

      // Convert to buffer for processing
      const buffer = Buffer.concat(result);

      // Prepare multiple interpretations of the data
      const response = {
        success: true,
        address: address,
        count: count,
        raw: Array.from(buffer),
        uint16: ModbusClient.bufferToUint16(buffer),
        int16: ModbusClient.bufferToInt16(buffer),
        hex: buffer.toString('hex').toUpperCase()
      };

      // Add 32-bit interpretations if we read more than 1 register
      if (count >= 2) {
        response.uint32 = ModbusClient.bufferToUint32(buffer);
        response.int32 = ModbusClient.bufferToInt32(buffer);
      }

      return response;
    } catch (error) {
      this.error('Error reading register:', error);
      return {
        success: false,
        error: error.message
      };
    } finally {
      // Disconnect after the operation
      this.testModbus.disconnect();
    }
  }

  /**
   * Write a value to a Modbus register
   * @param {string} deviceId - The device ID
   * @param {number} address - The register address
   * @param {number} value - The value to write
   */
  async writeRegister(deviceId, address, value) {
    const device = this.getVenusDeviceById(deviceId);
    if (!device) {
      throw new Error('Device not found');
    }

    const settings = device.getSettings();
    const ip = settings.ip;
    const port = settings.port || 502;
    const slaveId = settings.slave_id || 1;

    try {
      // Connect to the device
      await this.testModbus.connect({ ip, port });

      // Write the register
      await this.testModbus.writeSingleRegister(slaveId, address, value);

      this.log(`Successfully wrote value ${value} to register ${address}`);

      return {
        success: true,
        address: address,
        value: value
      };
    } catch (error) {
      this.error('Error writing register:', error);
      return {
        success: false,
        error: error.message
      };
    } finally {
      // Disconnect after the operation
      this.testModbus.disconnect();
    }
  }

  /**
   * Poll all known registers from a device
   * Returns the raw values for debugging
   * @param {string} deviceId - The device ID
   */
  async pollDeviceState(deviceId) {
    const device = this.getVenusDeviceById(deviceId);
    if (!device) {
      throw new Error('Device not found');
    }

    const settings = device.getSettings();
    const ip = settings.ip;
    const port = settings.port || 502;
    const slaveId = settings.slave_id || 1;

    const data = {
      deviceInfo: {},
      batteryState: {},
      systemState: {},
      controlRegisters: {},
      protectionSettings: {},
      alarms: {}
    };

    try {
      // Connect to the device
      await this.testModbus.connect({ ip, port });

      // Device Info registers
      try {
        const deviceName = await this.testModbus.readHoldingRegisters(slaveId, 31000, 10);
        data.deviceInfo['31000_device_name'] = ModbusClient.bufferToString(deviceName);
      } catch (e) { data.deviceInfo['31000_device_name'] = 'Error: ' + e.message; }

      try {
        const firmware = await this.testModbus.readHoldingRegisters(slaveId, 31101, 1);
        data.deviceInfo['31101_firmware'] = ModbusClient.bufferToUint16(Buffer.concat(firmware));
      } catch (e) { data.deviceInfo['31101_firmware'] = 'Error: ' + e.message; }

      try {
        const totalEnergy = await this.testModbus.readHoldingRegisters(slaveId, 32105, 1);
        data.deviceInfo['32105_total_energy_kwh'] = ModbusClient.bufferToUint16(Buffer.concat(totalEnergy)) * 0.001;
      } catch (e) { data.deviceInfo['32105_total_energy'] = 'Error: ' + e.message; }

      // Battery State registers
      try {
        const battVoltage = await this.testModbus.readHoldingRegisters(slaveId, 32100, 1);
        data.batteryState['32100_battery_voltage_raw'] = ModbusClient.bufferToUint16(Buffer.concat(battVoltage));
        data.batteryState['32100_battery_voltage_V'] = ModbusClient.bufferToUint16(Buffer.concat(battVoltage)) * 0.01;
      } catch (e) { data.batteryState['32100_battery_voltage'] = 'Error: ' + e.message; }

      try {
        const battCurrent = await this.testModbus.readHoldingRegisters(slaveId, 32101, 1);
        data.batteryState['32101_battery_current_raw'] = ModbusClient.bufferToInt16(Buffer.concat(battCurrent));
        data.batteryState['32101_battery_current_A'] = ModbusClient.bufferToInt16(Buffer.concat(battCurrent)) * 0.01;
      } catch (e) { data.batteryState['32101_battery_current'] = 'Error: ' + e.message; }

      try {
        const battPower = await this.testModbus.readHoldingRegisters(slaveId, 32102, 2);
        data.batteryState['32102_battery_power_W'] = ModbusClient.bufferToInt32(Buffer.concat(battPower));
      } catch (e) { data.batteryState['32102_battery_power'] = 'Error: ' + e.message; }

      try {
        const soc = await this.testModbus.readHoldingRegisters(slaveId, 32104, 1);
        data.batteryState['32104_soc_percent'] = ModbusClient.bufferToUint16(Buffer.concat(soc));
      } catch (e) { data.batteryState['32104_soc'] = 'Error: ' + e.message; }

      // AC Output registers
      try {
        const acVoltage = await this.testModbus.readHoldingRegisters(slaveId, 32200, 1);
        data.batteryState['32200_ac_voltage_raw'] = ModbusClient.bufferToUint16(Buffer.concat(acVoltage));
        data.batteryState['32200_ac_voltage_V'] = ModbusClient.bufferToUint16(Buffer.concat(acVoltage)) * 0.1;
      } catch (e) { data.batteryState['32200_ac_voltage'] = 'Error: ' + e.message; }

      try {
        const acCurrent = await this.testModbus.readHoldingRegisters(slaveId, 32201, 1);
        data.batteryState['32201_ac_current_raw'] = ModbusClient.bufferToInt16(Buffer.concat(acCurrent));
      } catch (e) { data.batteryState['32201_ac_current'] = 'Error: ' + e.message; }

      try {
        const acPower = await this.testModbus.readHoldingRegisters(slaveId, 32202, 2);
        data.batteryState['32202_ac_power_W'] = ModbusClient.bufferToInt32(Buffer.concat(acPower));
      } catch (e) { data.batteryState['32202_ac_power'] = 'Error: ' + e.message; }

      // Energy totals
      try {
        const totalCharge = await this.testModbus.readHoldingRegisters(slaveId, 33000, 2);
        data.batteryState['33000_total_charge_energy_kWh'] = ModbusClient.bufferToUint32(Buffer.concat(totalCharge)) * 0.01;
      } catch (e) { data.batteryState['33000_total_charge_energy'] = 'Error: ' + e.message; }

      try {
        const totalDischarge = await this.testModbus.readHoldingRegisters(slaveId, 33002, 2);
        data.batteryState['33002_total_discharge_energy_kWh'] = ModbusClient.bufferToInt32(Buffer.concat(totalDischarge)) * 0.01;
      } catch (e) { data.batteryState['33002_total_discharge_energy'] = 'Error: ' + e.message; }

      // Temperatures
      try {
        const tempInt = await this.testModbus.readHoldingRegisters(slaveId, 35000, 1);
        data.batteryState['35000_internal_temp_C'] = ModbusClient.bufferToInt16(Buffer.concat(tempInt)) * 0.1;
      } catch (e) { data.batteryState['35000_internal_temp'] = 'Error: ' + e.message; }

      try {
        const tempMos1 = await this.testModbus.readHoldingRegisters(slaveId, 35001, 1);
        data.batteryState['35001_mos1_temp_C'] = ModbusClient.bufferToInt16(Buffer.concat(tempMos1)) * 0.1;
      } catch (e) { data.batteryState['35001_mos1_temp'] = 'Error: ' + e.message; }

      try {
        const tempMos2 = await this.testModbus.readHoldingRegisters(slaveId, 35002, 1);
        data.batteryState['35002_mos2_temp_C'] = ModbusClient.bufferToInt16(Buffer.concat(tempMos2)) * 0.1;
      } catch (e) { data.batteryState['35002_mos2_temp'] = 'Error: ' + e.message; }

      // System State registers
      try {
        const inverterState = await this.testModbus.readHoldingRegisters(slaveId, 35100, 1);
        const stateVal = ModbusClient.bufferToUint16(Buffer.concat(inverterState));
        const stateNames = ['sleep', 'standby', 'charge', 'discharge', 'backup', 'update', 'bypass'];
        data.systemState['35100_inverter_state_raw'] = stateVal;
        data.systemState['35100_inverter_state_name'] = stateNames[stateVal] || 'unknown';
      } catch (e) { data.systemState['35100_inverter_state'] = 'Error: ' + e.message; }

      // Control registers
      try {
        const backupMode = await this.testModbus.readHoldingRegisters(slaveId, 41200, 1);
        data.controlRegisters['41200_backup_mode_raw'] = ModbusClient.bufferToUint16(Buffer.concat(backupMode));
        data.controlRegisters['41200_backup_enabled'] = ModbusClient.bufferToUint16(Buffer.concat(backupMode)) === 0;
      } catch (e) { data.controlRegisters['41200_backup_mode'] = 'Error: ' + e.message; }

      try {
        const rs485Control = await this.testModbus.readHoldingRegisters(slaveId, 42000, 1);
        const rs485Val = ModbusClient.bufferToUint16(Buffer.concat(rs485Control));
        data.controlRegisters['42000_rs485_control_raw'] = rs485Val;
        data.controlRegisters['42000_rs485_control_hex'] = '0x' + rs485Val.toString(16).toUpperCase();
        data.controlRegisters['42000_modbus_enabled'] = rs485Val === 21930;
      } catch (e) { data.controlRegisters['42000_rs485_control'] = 'Error: ' + e.message; }

      try {
        const forceMode = await this.testModbus.readHoldingRegisters(slaveId, 42010, 1);
        const forceModeVal = ModbusClient.bufferToUint16(Buffer.concat(forceMode));
        const forceModeNames = ['none', 'force_charge', 'force_discharge'];
        data.controlRegisters['42010_force_mode_raw'] = forceModeVal;
        data.controlRegisters['42010_force_mode_name'] = forceModeNames[forceModeVal] || 'unknown';
      } catch (e) { data.controlRegisters['42010_force_mode'] = 'Error: ' + e.message; }

      try {
        const chargeSoc = await this.testModbus.readHoldingRegisters(slaveId, 42011, 1);
        data.controlRegisters['42011_charge_to_soc_percent'] = ModbusClient.bufferToUint16(Buffer.concat(chargeSoc));
      } catch (e) { data.controlRegisters['42011_charge_to_soc'] = 'Error: ' + e.message; }

      try {
        const forceChargePower = await this.testModbus.readHoldingRegisters(slaveId, 42020, 1);
        data.controlRegisters['42020_force_charge_power_W'] = ModbusClient.bufferToUint16(Buffer.concat(forceChargePower));
      } catch (e) { data.controlRegisters['42020_force_charge_power'] = 'Error: ' + e.message; }

      try {
        const forceDischargePower = await this.testModbus.readHoldingRegisters(slaveId, 42021, 1);
        data.controlRegisters['42021_force_discharge_power_W'] = ModbusClient.bufferToUint16(Buffer.concat(forceDischargePower));
      } catch (e) { data.controlRegisters['42021_force_discharge_power'] = 'Error: ' + e.message; }

      try {
        const workMode = await this.testModbus.readHoldingRegisters(slaveId, 43000, 1);
        const workModeVal = ModbusClient.bufferToUint16(Buffer.concat(workMode));
        const workModeNames = ['manual', 'anti_feed', 'trade_mode', 'control_mode'];
        data.controlRegisters['43000_user_work_mode_raw'] = workModeVal;
        data.controlRegisters['43000_user_work_mode_name'] = workModeNames[workModeVal] || 'unknown (' + workModeVal + ')';
      } catch (e) { data.controlRegisters['43000_user_work_mode'] = 'Error: ' + e.message; }

      // Protection settings
      try {
        const chargeCutoff = await this.testModbus.readHoldingRegisters(slaveId, 44000, 1);
        data.protectionSettings['44000_charging_cutoff_soc_raw'] = ModbusClient.bufferToUint16(Buffer.concat(chargeCutoff));
        data.protectionSettings['44000_charging_cutoff_soc_percent'] = ModbusClient.bufferToUint16(Buffer.concat(chargeCutoff)) * 0.1;
      } catch (e) { data.protectionSettings['44000_charging_cutoff_soc'] = 'Error: ' + e.message; }

      try {
        const dischargeCutoff = await this.testModbus.readHoldingRegisters(slaveId, 44001, 1);
        data.protectionSettings['44001_discharging_cutoff_soc_raw'] = ModbusClient.bufferToUint16(Buffer.concat(dischargeCutoff));
        data.protectionSettings['44001_discharging_cutoff_soc_percent'] = ModbusClient.bufferToUint16(Buffer.concat(dischargeCutoff)) * 0.1;
      } catch (e) { data.protectionSettings['44001_discharging_cutoff_soc'] = 'Error: ' + e.message; }

      try {
        const maxChargePower = await this.testModbus.readHoldingRegisters(slaveId, 44002, 1);
        data.protectionSettings['44002_max_charge_power_W'] = ModbusClient.bufferToUint16(Buffer.concat(maxChargePower));
      } catch (e) { data.protectionSettings['44002_max_charge_power'] = 'Error: ' + e.message; }

      try {
        const maxDischargePower = await this.testModbus.readHoldingRegisters(slaveId, 44003, 1);
        data.protectionSettings['44003_max_discharge_power_W'] = ModbusClient.bufferToUint16(Buffer.concat(maxDischargePower));
      } catch (e) { data.protectionSettings['44003_max_discharge_power'] = 'Error: ' + e.message; }

      // Alarm registers
      try {
        const alarmCode = await this.testModbus.readHoldingRegisters(slaveId, 36000, 1);
        data.alarms['36000_alarm_code'] = ModbusClient.bufferToUint16(Buffer.concat(alarmCode));
      } catch (e) { data.alarms['36000_alarm_code'] = 'Error: ' + e.message; }

      try {
        const faultWord = await this.testModbus.readHoldingRegisters(slaveId, 36100, 1);
        data.alarms['36100_fault_word'] = ModbusClient.bufferToUint16(Buffer.concat(faultWord));
      } catch (e) { data.alarms['36100_fault_word'] = 'Error: ' + e.message; }

      return {
        success: true,
        data: data
      };
    } catch (error) {
      this.error('Error polling device state:', error);
      return {
        success: false,
        error: error.message
      };
    } finally {
      // Disconnect after the operation
      this.testModbus.disconnect();
    }
  }
};
