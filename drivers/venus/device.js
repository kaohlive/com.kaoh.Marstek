'use strict';

const Homey = require('homey');
const ModbusClient = require('../../api/ModbusClient');

class VenusBatteryDevice extends Homey.Device {

  async onInit() {
    this.log('VenusBattery Device has been initialized');

    // Get device settings
    this.settings = this.getSettings();
    
    // Initialize Modbus client
    this.modbus = new ModbusClient();
    
    // Previous values for event detection
    this.previousValues = {};
    
    // Setup Modbus event handlers
    this.setupModbusHandlers();
    
    // Start polling
    this.startPolling();
    
    // Register capability listeners for writable registers
    this.setupCapabilityListeners();
    //Register flow trigger cards
    this.registerFlowCardTriggers();
    //Setup some global vars that we get from the device on init
    this.batteryCapacity=0;
    this.deviceVersion = 'unknown'; // Will be set to 'v1v2' or 'v3' based on firmware
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);
    
    if (changedKeys.includes('ip') || changedKeys.includes('port') || changedKeys.includes('poll_interval')) {
      this.settings = newSettings;
      this.restartPolling();
    }
  }

  async onRenamed(name) {
    try {
      this.log(`Device renamed to: "${name}"`);
      
      // Configuration for your specific device
      const config = {
        deviceNameRegister: 31000,  // Starting register for device name
        maxNameLength: 20,          // Maximum name length in bytes
        encoding: 'ascii',          // Character encoding
        swapBytes: false,           // Set to true if device expects swapped bytes
        littleEndian: false,        // Set to true if device uses little-endian
        padWithNull: true,          // Pad short names with null bytes
        slaveId: this.settings.slave_id || 1  // Modbus slave ID
      };
      
      // Write the new name to the device
      //await this.writeDeviceName(name, config);
      
    } catch (error) {
      this.error('Failed to write device name to Modbus device:', error);
    }
  }

async writeDeviceName(name, config) {
    const {
      deviceNameRegister,
      maxNameLength,
      encoding,
      swapBytes,
      littleEndian,
      padWithNull,
      slaveId
    } = config;
    
    // Convert string to buffer
    const buffer = this.modbus.stringToModbusBuffer(name, maxNameLength, {
      encoding,
      padWithNull,
      swapBytes
    });
    
    // Convert buffer to register values
    const registers = bufferToRegisters(buffer, littleEndian);
    
    this.log(`Writing name "${name}" as ${registers.length} registers:`, registers);
    
    // Write to Modbus device
    // Method 1: Write all registers at once (if supported)
    try {
      await this.modbus.writeMultipleRegisters(slaveId, deviceNameRegister, registers);
      this.log(`Successfully wrote device name to registers ${deviceNameRegister}-${deviceNameRegister + registers.length - 1}`);
    } catch (error) {
      // Method 2: Write registers individually if bulk write fails
      this.log('Bulk write failed, trying individual register writes...');
      
      for (let i = 0; i < registers.length; i++) {
        await this.modbus.writeSingleRegister(slaveId, deviceNameRegister + i, registers[i]);
        // Small delay between writes to avoid overwhelming the device
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      this.log(`Successfully wrote device name using individual register writes`);
    }
  }

  setupModbusHandlers() {
    this.modbus.on('connect', () => {
      this.setAvailable();
      this.log('Connected to Modbus device');
      this.processDeviceStaticInfo(this.settings.slave_id || 1);
    });

    this.modbus.on('error', (error) => {
      if(!this.modbus.isConnected())
        this.setUnavailable(`Connection failed: ${error.message}`);
      this.log('Modbus connection error:', error);
    });

    this.modbus.on('close', () => {
      this.log('Modbus connection closed');
    });
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
    
    // Initial poll
    setTimeout(() => this.pollData(), 1000);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  restartPolling() {
    this.stopPolling();
    this.disconnectModbus();
    this.startPolling();
  }

  //Update info that does not change often, we do this on device init, if you whant new data, just restart the app
  async processDeviceStaticInfo(slaveId)
  {
    try{
      // Battery total energy, this is the capacity of the device, not chaning (0.001kwh resolution)
      const reg_energy = await this.modbus.readHoldingRegisters(slaveId, 32105, 1);
      this.batteryCapacity = ModbusClient.bufferToUint16(Buffer.concat(reg_energy)) * 0.001; // Now in kwh

      const reg_device_name = await this.modbus.readHoldingRegisters(slaveId, 31000, 10);
      // Simple conversion
      const deviceName = ModbusClient.bufferToString(reg_device_name);

      // Read firmware version from register 31101 (Firmware version)
      let firmwareVersion='xxx';
      try{
        const reg_firmware = await this.modbus.readHoldingRegisters(slaveId, 31101, 1);
        const firmwareRaw = ModbusClient.bufferToUint16(Buffer.concat(reg_firmware));
        firmwareVersion = firmwareRaw.toString(); // Firmware register already contains the correct value
      } catch (error) {
        this.log('Device firmware retrieval error:', error);
      }
      // Determine device version based on device name - more reliable than firmware version
      // V3 devices typically have names like "AC01", while V1/V2 have "limited", "BI_2.5_2.5", etc.
      const deviceNameLower = deviceName.toLowerCase().trim();

      // V3 device detection patterns
      if (deviceNameLower.startsWith('ac')) {
        this.deviceVersion = 'v2';
      } else if (deviceNameLower.includes('limited') || deviceNameLower.includes('bi_')) {
        this.deviceVersion = 'v1';
      } else if (deviceNameLower.startsWith('vn')) {
        this.deviceVersion = 'v3';
      } else {
        // Fallback to firmware version detection if device name is unclear
        this.deviceVersion = firmwareRaw >= 300 ? 'v3' : 'v1v2';
        this.log(`Using firmware fallback for version detection - unknown device name: ${deviceName}`);
      }

      this.log(`Detected device version: ${this.deviceVersion} (device: "${deviceName}", firmware: ${firmwareVersion})`);

      //Now store the collected info in read only settings for easy access to the user
      this.setSettings({
        'storage_capacity': this.batteryCapacity + ' kwh',
        'device_name': deviceName,
        'firmware': firmwareVersion,
        'device_version': this.deviceVersion
      });
      //We only manage these from Homey since the Marstek app does not allow to control these
      //Force charge power
      const reg_forcecharge = await this.modbus.readHoldingRegisters(slaveId, 42020, 1);
      const force_charge = ModbusClient.bufferToUint16(Buffer.concat(reg_forcecharge));
      console.log('current charge power forced setting :'+force_charge);
      this.setCapabilityValue('force_charge_power', force_charge).catch(this.error);
      //Force discharge power
      const reg_forcedischarge = await this.modbus.readHoldingRegisters(slaveId, 42021, 1);
      const force_discharge = ModbusClient.bufferToUint16(Buffer.concat(reg_forcedischarge));
      console.log('current discharge power forced setting :'+force_discharge);
      this.setCapabilityValue('force_discharge_power', force_discharge).catch(this.error);
    } catch (error) {
      this.log('Device static info error:', error);
      this.setUnavailable(`Retrieval of static info failed: ${error.message}`);
    }
  }

  async pollData() {
    if (!await this.connectModbus()) {
      return;
    }

    try {
      const slaveId = this.settings.slave_id || 1;
      console.log('Attempt to read registers for slave device ['+slaveId+']')
      // Read battery status registers (example addresses based on typical battery systems)
      console.log('Get battery data [slave '+slaveId+']')
      await this.processBatteryState(slaveId);

      console.log('Get battery health [slave '+slaveId+']')
      await this.processBatteryState(slaveId);

      // Read system health data
      console.log('Get system health [slave '+slaveId+']')
      this.processBatteryHealth(slaveId);

      // Read system operation status registers
      console.log('Get system data [slave '+slaveId+']')
      this.processSystemData(slaveId);

    } catch (error) {
      this.log('Polling error:', error);
      this.setUnavailable(`Polling failed: ${error.message}`);
    }
  }

  async processBatteryState(slaveId) {
    try {
      // AC Output voltage (0.1V resolution)
      const reg_voltage_ac =await this.modbus.readHoldingRegisters(slaveId, 32200, 1);
      const voltage_ac = ModbusClient.bufferToUint16(Buffer.concat(reg_voltage_ac)) * 0.1;
      this.setCapabilityValue('measure_voltage', voltage_ac).catch(this.error);
      // AC Output current (0.1A resolution, signed) - V3 devices use different scaling
      const reg_current_ac = await this.modbus.readHoldingRegisters(slaveId, 32201, 1);
      const current_ac_raw = ModbusClient.bufferToInt16(Buffer.concat(reg_current_ac));
      // Different scaling for different device versions
      let current_ac;
      if (this.deviceVersion === 'v3') {
        current_ac = current_ac_raw * 0.001; // V3 devices use 0.001 scaling
      } else {
        current_ac = current_ac_raw * 0.01; // V1 and V2 devices use 0.01 scaling
      }
      this.setCapabilityValue('measure_current', current_ac).catch(this.error);
      //AC power output, this is the main interaction between our house and the ESS
      const reg_power_ac = await this.modbus.readHoldingRegisters(slaveId, 32202, 2);
      const power_ac = ModbusClient.bufferToInt32(Buffer.concat(reg_power_ac));
      //For homey we need to invert the power measure
      this.setCapabilityValue('measure_power', (power_ac*-1)).catch(this.error);
      //But we also set the discharge and charge versions for easy of use
      if (power_ac < 0) {
        this.setCapabilityValue('measure_power.imported', Math.abs(power_ac)).catch(this.error);
        this.setCapabilityValue('measure_power.exported', 0).catch(this.error);
      } else {
        this.setCapabilityValue('measure_power.imported', 0).catch(this.error);
        this.setCapabilityValue('measure_power.exported', Math.abs(power_ac)).catch(this.error);
      }
      // State of Charge (1% resolution)
      const reg_soc = await this.modbus.readHoldingRegisters(slaveId, 32104, 1);
      const soc=ModbusClient.bufferToUint16(Buffer.concat(reg_soc));
      this.setCapabilityValue('measure_battery', soc).catch(this.error);
      const stored_energy = this.batteryCapacity * (soc/100);
      this.setCapabilityValue('meter_power.capacity', stored_energy).catch(this.error);
      
      // Trigger SOC events
      this.triggerSOCEvents(soc);

      // Battery power, these are internal pre inverter values (1W resolution, signed)
      const reg_power = await this.modbus.readHoldingRegisters(slaveId, 32102, 2);
      const power = ModbusClient.bufferToInt32(Buffer.concat(reg_power)); //Homey want w
      
      //First we set the main measure capability
      this.setCapabilityValue('measure_power.battery', power).catch(this.error);
      // Battery voltage (0.1V resolution)
      const reg_voltage =await this.modbus.readHoldingRegisters(slaveId, 32100, 1);
      const voltage = ModbusClient.bufferToUint16(Buffer.concat(reg_voltage)) * 0.01;
      this.setCapabilityValue('measure_voltage.battery', voltage).catch(this.error);

      // Battery current (0.1A resolution, signed) - V3 devices use different scaling
      const reg_current = await this.modbus.readHoldingRegisters(slaveId, 32101, 1);
      const current_raw = ModbusClient.bufferToInt16(Buffer.concat(reg_current));
      // Different scaling for different device versions
      let current;
      if (this.deviceVersion === 'v3') {
        current = current_raw * 0.001; // V3 devices use 0.001 scaling
      } else {
        current = current_raw * 0.01; // V1 and V2 devices use 0.01 scaling
      }
      this.setCapabilityValue('measure_current.battery', current).catch(this.error);

    } catch (error) {
      this.log('Error processing battery state:', error);
    }
  }

  async processBatteryHealth(slaveId) {
    try {
      // Internal Temperature
      const reg_temp_int =await this.modbus.readHoldingRegisters(slaveId, 35000, 1);
      const temp_int = ModbusClient.bufferToInt16(Buffer.concat(reg_temp_int)) * 0.1;
      this.setCapabilityValue('measure_temperature', temp_int).catch(this.error);

      // Internal mos1
      const reg_temp_mos1 =await this.modbus.readHoldingRegisters(slaveId, 35001, 1);
      const temp_mos1 = ModbusClient.bufferToInt16(Buffer.concat(reg_temp_mos1)) * 0.1;
      this.setCapabilityValue('measure_temperature.mos1', temp_mos1).catch(this.error);
      // Internal mos1
      const reg_temp_mos2 =await this.modbus.readHoldingRegisters(slaveId, 35002, 1);
      const temp_mos2 = ModbusClient.bufferToInt16(Buffer.concat(reg_temp_mos2)) * 0.1;
      this.setCapabilityValue('measure_temperature.mos2', temp_mos2).catch(this.error);

      // Process alarm and fault codes, but they dont seem to work for v3
      if (this.deviceVersion !== 'v3') {
        await this.processAlarmCodes(slaveId);
      }
    } catch (error) {
      this.log('Error processing battery state:', error);
    }
  }

  async processSystemData(slaveId) {

    try {

      // Battery total chargin energy (0.001kwh resolution)
      const reg_total_charge_energy = await this.modbus.readHoldingRegisters(slaveId, 33000, 2);
      const total_charge_energy = ModbusClient.bufferToUint32(Buffer.concat(reg_total_charge_energy)) * 0.01; // Now in kwh
      this.setCapabilityValue('meter_power.imported', total_charge_energy).catch(this.error);

      // Battery total discharge energy (0.001kwh resolution)
      const reg_total_discharge_energy = await this.modbus.readHoldingRegisters(slaveId, 33002, 2);
      const total_discharge_energy = ModbusClient.bufferToInt32(Buffer.concat(reg_total_discharge_energy)) * 0.01; // Now in kwh
      this.setCapabilityValue('meter_power.exported', total_discharge_energy).catch(this.error);

      // Inverter state
      const reg_inverter_state = await this.modbus.readHoldingRegisters(slaveId, 35100, 1);
      const inverter_state = ModbusClient.bufferToUint16(Buffer.concat(reg_inverter_state));
      const modeStr = this.driver.INVERTER_MODES[inverter_state];
      // Trigger operation mode change event
      const previousMode = this.getCapabilityValue('operation_mode');

      // Only set capability if value changed to prevent unnecessary triggers
      if (previousMode !== modeStr) {
        this.setCapabilityValue('operation_mode', modeStr).catch(this.error);

        // Trigger operation mode change event only after value is set and if there was a previous value
        if (previousMode) {
          this.homey.flow.getDeviceTriggerCard('operation_mode_changed')
            .trigger(this, { mode: modeStr }, { mode: modeStr })
            .catch(this.error);
        }
      }
      //Force mode
      const reg_force_mode = await this.modbus.readHoldingRegisters(slaveId, 42010, 1);
      const force_mode = ModbusClient.bufferToUint16(Buffer.concat(reg_force_mode));
      const forceModeStr = this.driver.FORCE_MODES[force_mode];
      console.log('current charge mode forced :'+force_mode);

      // Only set capability if value changed to prevent unnecessary triggers
      const currentForceMode = this.getCapabilityValue('force_charge_mode');
      if (currentForceMode !== forceModeStr) {
        this.setCapabilityValue('force_charge_mode', forceModeStr).catch(this.error);
      }
      //Work mode
      const reg_work_mode = await this.modbus.readHoldingRegisters(slaveId, 43000, 1);
      let work_mode = ModbusClient.bufferToUint16(Buffer.concat(reg_work_mode));
      const reg_force_mode_state = await this.modbus.readHoldingRegisters(slaveId, 42000, 1);
      const force_mode_state = ModbusClient.bufferToUint16(Buffer.concat(reg_force_mode_state));
      console.log('force mode enabled? ('+force_mode_state+'): '+(force_mode_state==21930));
      if(force_mode_state==21930)
        work_mode=3;
      console.log('workmode: '+work_mode);
      const workModeStr = this.driver.WORK_MODES[work_mode];

      // Only set capability if value changed to prevent unnecessary triggers
      const currentWorkMode = this.getCapabilityValue('user_work_mode');
      if (currentWorkMode !== workModeStr) {
        this.setCapabilityValue('user_work_mode', workModeStr).catch(this.error);
      }
      //Process charging status from operation mode
      this.processChargingStatus(modeStr);
      //Get current force SOC target
      const reg_force_soc = await this.modbus.readHoldingRegisters(slaveId, 42011, 1);
      const force_soc = ModbusClient.bufferToUint16(Buffer.concat(reg_force_soc));
      console.log('Force charge target: '+force_soc+'%')

      // Only set capability if value changed to prevent unnecessary triggers
      const currentForceTarget = this.getCapabilityValue('force_charge_target');
      if (currentForceTarget !== force_soc) {
        this.setCapabilityValue('force_charge_target', force_soc).catch(this.error);
      }
      //Get current backup mode
      const reg_backup_mode = await this.modbus.readHoldingRegisters(slaveId, 41200, 1);
      const backup_mode = ModbusClient.bufferToUint16(Buffer.concat(reg_backup_mode));
      const backupModeValue = (backup_mode==0);
      console.log('Backup Mode: '+backupModeValue)

      // Only set capability if value changed to prevent unnecessary triggers
      const currentBackupMode = this.getCapabilityValue('backup_mode');
      if (currentBackupMode !== backupModeValue) {
        this.setCapabilityValue('backup_mode', backupModeValue).catch(this.error);
      }

    } catch (error) {
      this.log('Error processing system data:', error);
    }
  }

  async processAlarmCodes(slaveId) {
    try {
      const alarms = [];
      const systemAlarms = [];
      const gridAlarms = [];
      const batteryAlarms = [];
      const hardwareAlarms = [];
      const systemFaultAlarms = [];
      let hasAlarm = false;

      // Default register values (assume no alarms if register doesn't exist)
      let alarm_code = 0;
      let grid_fault = 0;
      let battery_fault = 0;
      let hardware_fault = 0;

      // Try to read alarm code (36000) - System alarms
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
      } catch (error) {
        this.log(`Alarm register 36000 not available: ${error.message}`);
      }

      // Try to read grid fault word (36100) - Grid faults
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
      } catch (error) {
        this.log(`Grid fault register 36100 not available: ${error.message}`);
      }

      // Try to read battery fault word (36101) - Battery faults
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
      } catch (error) {
        this.log(`Battery fault register 36101 not available: ${error.message}`);
      }

      // Try to read hardware fault word (36103) - Hardware faults
      try {
        const reg_hardware_fault = await this.modbus.readHoldingRegisters(slaveId, 36103, 1);
        hardware_fault = ModbusClient.bufferToUint16(Buffer.concat(reg_hardware_fault));

        if (hardware_fault > 0) {
          hasAlarm = true;
          if (hardware_fault & 0x001) { alarms.push('Hardware Bus Overvoltage'); hardwareAlarms.push('Hardware Bus Overvoltage'); }
          if (hardware_fault & 0x002) { alarms.push('Hardware Output Overcurrent'); hardwareAlarms.push('Hardware Output Overcurrent'); }
          if (hardware_fault & 0x004) { alarms.push('Hardware Trans Overcurrent'); hardwareAlarms.push('Hardware Trans Overcurrent'); }
          if (hardware_fault & 0x008) { alarms.push('Hardware Battery Overcurrent'); hardwareAlarms.push('Hardware Battery Overcurrent'); }
          if (hardware_fault & 0x010) { alarms.push('Hardware Protection'); hardwareAlarms.push('Hardware Protection'); }
          if (hardware_fault & 0x020) { alarms.push('Output Overcurrent'); hardwareAlarms.push('Output Overcurrent'); }
          if (hardware_fault & 0x040) { alarms.push('High Voltage Bus Overvoltage'); hardwareAlarms.push('High Voltage Bus Overvoltage'); }
          if (hardware_fault & 0x080) { alarms.push('High Voltage Bus Undervoltage'); hardwareAlarms.push('High Voltage Bus Undervoltage'); }
          if (hardware_fault & 0x100) { alarms.push('Overpower Protection'); hardwareAlarms.push('Overpower Protection'); }
          if (hardware_fault & 0x200) { alarms.push('FSM Abnormal'); hardwareAlarms.push('FSM Abnormal'); }
          if (hardware_fault & 0x400) { alarms.push('Overtemperature Protection'); hardwareAlarms.push('Overtemperature Protection'); }
          if (hardware_fault & 0x800) { alarms.push('Inverter Soft Start Timeout'); hardwareAlarms.push('Inverter Soft Start Timeout'); }
        }
      } catch (error) {
        this.log(`Hardware fault register 36103 not available: ${error.message}`);
      }

      // Register 36104 not available on this device - skipping system fault detection

      // Update alarm capability and set warning if needed
      const currentAlarm = this.getCapabilityValue('alarm_generic');
      if (currentAlarm !== hasAlarm) {
        this.setCapabilityValue('alarm_generic', hasAlarm).catch(this.error);
      }

      // Set warning with specific alarm details and trigger workflow cards
      if (hasAlarm && alarms.length > 0) {
        const alarmMessage = `Device alarms detected: ${alarms.join(', ')}`;
        const alarmCodes = `System:${alarm_code},Grid:${grid_fault},Battery:${battery_fault},Hardware:${hardware_fault}`;

        this.setWarning(alarmMessage);
        this.log(`Alarms detected: ${alarmMessage}`);

        // Trigger general battery fault detected event with tokens
        this.homey.flow.getDeviceTriggerCard('battery_fault_detected')
          .trigger(this,
            { message: alarmMessage, alarm_codes: alarmCodes },
            {}
          )
          .catch(this.error);

        // Trigger specific alarm type events with detailed messages for available registers
        if (gridAlarms.length > 0) {
          const gridMessage = gridAlarms.join(', ');
          this.homey.flow.getDeviceTriggerCard('grid_fault_detected')
            .trigger(this, { message: gridMessage }, {})
            .catch(this.error);
        }

        if (batteryAlarms.length > 0) {
          const batteryMessage = batteryAlarms.join(', ');
          this.homey.flow.getDeviceTriggerCard('battery_system_fault_detected')
            .trigger(this, { message: batteryMessage }, {})
            .catch(this.error);
        }

        if (hardwareAlarms.length > 0) {
          const hardwareMessage = hardwareAlarms.join(', ');
          this.homey.flow.getDeviceTriggerCard('hardware_fault_detected')
            .trigger(this, { message: hardwareMessage }, {})
            .catch(this.error);
        }

        // Use generic battery warning for system alarms (since specific system fault register isn't available)
        if (systemAlarms.length > 0) {
          const warningMessage = systemAlarms.join(', ');
          this.homey.flow.getDeviceTriggerCard('battery_warning_detected')
            .trigger(this,
              { message: warningMessage, alarm_codes: alarmCodes },
              {}
            )
            .catch(this.error);
        }
      } else if (!hasAlarm) {
        // Clear warning when no alarms
        this.unsetWarning();
      }

    } catch (error) {
      this.log('Error processing alarm codes:', error);
    }
  }

  processChargingStatus(operationMode) {
    // Determine charging status based on operation mode
    // Standard battery_charging_state values: charging, discharging, idle
    let chargingStatus = 'idle';

    if (operationMode && operationMode.toLowerCase().includes('discharge')) {
      chargingStatus = 'discharging';
    } else if (operationMode && operationMode.toLowerCase().includes('charge')) {
      chargingStatus = 'charging';
    }

    // Only set capability if value changed to prevent unnecessary triggers
    const previousStatus = this.getCapabilityValue('battery_charging_state');
    if (previousStatus !== chargingStatus) {
      this.setCapabilityValue('battery_charging_state', chargingStatus).catch(this.error);

      // Trigger charging status change events
      this.homey.flow.getDeviceTriggerCard('charging_status_changed')
        .trigger(this, { status: chargingStatus }, { status: chargingStatus })
        .catch(this.error);

      if (chargingStatus === 'charging') {
        this.homey.flow.getDeviceTriggerCard('battery_started_charging')
          .trigger(this, {}, {})
          .catch(this.error);
      } else if (chargingStatus === 'discharging') {
        this.homey.flow.getDeviceTriggerCard('battery_started_discharging')
          .trigger(this, {}, {})
          .catch(this.error);
      }
    }
  }


  triggerSOCEvents(soc) {
    const previousSOC = this.previousValues.soc;
    
    if (previousSOC !== undefined) {
      // Trigger SOC threshold events
      const thresholds = [10, 20, 50, 80, 90];
      
      thresholds.forEach(threshold => {
        if (previousSOC > threshold && soc <= threshold) {
          this.homey.flow.getDeviceTriggerCard('soc_below_threshold')
            .trigger(this, { threshold }, { threshold })
            .catch(this.error);
        } else if (previousSOC < threshold && soc >= threshold) {
          this.homey.flow.getDeviceTriggerCard('soc_above_threshold')
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
      // Temperature alarm thresholds
      const highTemp = 50; // 50°C
      const lowTemp = -10; // -10°C
      
      if (previousTemp < highTemp && temperature >= highTemp) {
        this.homey.flow.getDeviceTriggerCard('temperature_too_high')
          .trigger(this, { temperature }, {})
          .catch(this.error);
      }
      
      if (previousTemp > lowTemp && temperature <= lowTemp) {
        this.homey.flow.getDeviceTriggerCard('temperature_too_low')
          .trigger(this, { temperature }, {})
          .catch(this.error);
      }
    }
    
    this.previousValues.temperature = temperature;
  }

  validateControlRequirement()
  {
    return new Promise((resolve, reject) => {
      const currentChargeMode = this.getCapabilityValue('user_work_mode');
      if(currentChargeMode!=='control_mode')
      {
        this.setWarning('These controls only work in force control mode');
        return reject(new Error('Failed to set charge mode'));
      } else {
        resolve("Modbus control mode is enabled, proceed");
      }
    });  
  }

  async onCapabilityBackupMode(value, opts = {}) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }
      
      const slaveId = this.settings.slave_id || 1;
      await this.modbus.writeSingleRegister(slaveId, 41200, (value ? 0 : 1));
      this.log('Backup mode set to: '+value+', now trigger the worklow card:');
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

  // Write operations for supported registers
  async onCapabilityForceChargePower(value, opts = {}) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }
      
      const slaveId = this.settings.slave_id || 1;
      await this.modbus.writeSingleRegister(slaveId, 42020, Math.round(value));
      this.log('Force charge power set to:'+value+' and trigger the workflow');
      
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
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }
      
      const slaveId = this.settings.slave_id || 1;
      await this.modbus.writeSingleRegister(slaveId, 42021, Math.round(value));
      this.log('Force discharge power set to: '+value+', now trigger flow cards');
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
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }
      try {
        await this.validateControlRequirement();
      } catch (error) {
        throw error;
      }
      
      const slaveId = this.settings.slave_id || 1;
      const modeValue = Object.keys(this.driver.FORCE_MODES).find(
        key => this.driver.FORCE_MODES[key] === value
      );
      console.log('Attempt tp set mode to '+modeValue+' based on '+value);
      //We expect the work mode to be on force_control, else this is ignored
      await this.modbus.writeSingleRegister(slaveId, 42010, modeValue);
      this.log('Charge mode set to:', value);
      //Now trigger the workflow card
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

  //Sets the User Work Mode by turning the device in on eof the three automated operating modes
  //If the force control mode is selected it will turn on modbus control to allow the charge value to lead the bahavior
  async onCapabilityUserWorkMode(value, opts = {}) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }
      
      const slaveId = this.settings.slave_id || 1;
      const userWorkValue = Object.keys(this.driver.WORK_MODES).find(
        key => this.driver.WORK_MODES[key] === value
      );
      console.log('Attempt to set Work mode to '+userWorkValue+' based on '+value);
      if(userWorkValue==3)
      {
        this.log('We set the modbus control flag to true');
        //Turn on modbus control mode
        await this.modbus.writeSingleRegister(slaveId, 42000, 21930);
      } else {
        this.log('We set the modbus control mode to off');
        await this.setCapabilityValue('force_charge_mode','none');
        //Turn off the modbus control mode
        this.log('We set the modbus control flag to false');
        await this.modbus.writeSingleRegister(slaveId, 42000, 21947);
        //Now set the device to the right work mode
        this.log('We set the new work value');
        await this.modbus.writeSingleRegister(slaveId, 43000, userWorkValue);
      }
      this.log('Work mode set to:'+value+', now trigger the workflow card');

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

  async onCapabilityForceChargeTarget(value, opts = {}) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }
      
      try {
        await this.validateControlRequirement();
      } catch (error) {
        throw error;
      }

      const slaveId = this.settings.slave_id || 1;
      //Set the force SOC Target for forced charge/discharge
      await this.setCapabilityValue('force_charge_mode','force_soc');
      await this.modbus.writeSingleRegister(slaveId, 42011, value);
      this.log('Set the force SOC target to '+value+', now trigger the workflow')
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

  // Flow card condition handlers
  async conditionIsCharging() {
    const status = this.getCapabilityValue('charging_status');
    return status === 'charging';
  }

  async conditionIsDischarging() {
    const status = this.getCapabilityValue('charging_status');
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
    const mode = this.getCapabilityValue('operation_mode');
    return mode === args.mode;
  }

  async conditionHasFault() {
    const alarm = this.getCapabilityValue('alarm_generic');
    return alarm === true;
  }

  async conditionTemperatureAbove(args) {
    const temperature = this.getCapabilityValue('measure_temperature');
    return temperature > args.temperature;
  }

  // Flow card action handlers
  async actionSetChargeMode(args) {
    try {
      await this.onCapabilityChargeMode(args.mode);
      return true;
    } catch (error) {
      this.log('Flow action set charge mode failed:', error);
      throw error;
    }
  }

  async actionSetTargetPower(args) {
    try {
      await this.onCapabilityTargetPower(args.power);
      return true;
    } catch (error) {
      this.log('Flow action set target power failed:', error);
      throw error;
    }
  }

  async onDeleted() {
    this.log('VenusBatteryDevice deleted');
    this.stopPolling();
    this.disconnectModbus();
  }

  // ============================================
  // CONDITION METHODS
  // ============================================

  /**
   * Check if backup mode matches the specified state
   * @param {Object} args - Flow card arguments
   * @param {string} args.mode - "true" or "false" as string
   * @returns {boolean} - True if condition matches
   */
  async conditionBackupModeIs(args) {
    try {
      const currentMode = this.getCapabilityValue('backup_mode');
      const targetMode = args.mode === 'true';
      
      this.log(`Checking backup mode: current=${currentMode}, target=${targetMode}`);
      return currentMode === targetMode;
    } catch (error) {
      this.error('Error checking backup mode condition:', error);
      return false;
    }
  }

  /**
   * Check if force charge mode matches the specified mode
   * @param {Object} args - Flow card arguments
   * @param {string} args.mode - Mode ID (none, force_charge, force_discharge, force_soc)
   * @returns {boolean} - True if condition matches
   */
  async conditionForceChargeModeIs(args) {
    try {
      const currentMode = this.getCapabilityValue('force_charge_mode');
      
      this.log(`Checking force charge mode: current=${currentMode}, target=${args.mode}`);
      return currentMode === args.mode;
    } catch (error) {
      this.error('Error checking force charge mode condition:', error);
      return false;
    }
  }

  /**
   * Check if user work mode matches the specified mode
   * @param {Object} args - Flow card arguments
   * @param {string} args.mode - Mode ID (manual, anti_feed, trade_mode, control_mode)
   * @returns {boolean} - True if condition matches
   */
  async conditionUserWorkModeIs(args) {
    try {
      const currentMode = this.getCapabilityValue('user_work_mode');
      
      this.log(`Checking user work mode: current=${currentMode}, target=${args.mode}`);
      return currentMode === args.mode;
    } catch (error) {
      this.error('Error checking user work mode condition:', error);
      return false;
    }
  }

  /**
   * Check if force charge power is greater than threshold
   * @param {Object} args - Flow card arguments
   * @param {number} args.power - Power threshold in watts
   * @returns {boolean} - True if current power is greater than threshold
   */
  async conditionForceChargePowerGreaterThan(args) {
    try {
      const currentPower = this.getCapabilityValue('force_charge_power') || 0;
      const threshold = Number(args.power);
      
      this.log(`Checking force charge power: current=${currentPower}W, threshold=${threshold}W`);
      return currentPower > threshold;
    } catch (error) {
      this.error('Error checking force charge power condition:', error);
      return false;
    }
  }

  /**
   * Check if force discharge power is greater than threshold
   * @param {Object} args - Flow card arguments
   * @param {number} args.power - Power threshold in watts
   * @returns {boolean} - True if current power is greater than threshold
   */
  async conditionForceDischargePowerGreaterThan(args) {
    try {
      const currentPower = this.getCapabilityValue('force_discharge_power') || 0;
      const threshold = Number(args.power);
      
      this.log(`Checking force discharge power: current=${currentPower}W, threshold=${threshold}W`);
      return currentPower > threshold;
    } catch (error) {
      this.error('Error checking force discharge power condition:', error);
      return false;
    }
  }

  /**
   * Check if force charge target is greater than threshold
   * @param {Object} args - Flow card arguments
   * @param {number} args.target - SOC threshold in percentage
   * @returns {boolean} - True if current target is greater than threshold
   */
  async conditionForceChargeTargetGreaterThan(args) {
    try {
      const currentTarget = this.getCapabilityValue('force_charge_target') || 0;
      const threshold = Number(args.target);
      
      this.log(`Checking force charge target: current=${currentTarget}%, threshold=${threshold}%`);
      return currentTarget > threshold;
    } catch (error) {
      this.error('Error checking force charge target condition:', error);
      return false;
    }
  }

  // ============================================
  // ACTION METHODS
  // ============================================

  /**
   * Set backup mode on or off
   * @param {Object} args - Flow card arguments
   * @param {string} args.mode - "true" or "false" as string
   * @returns {boolean} - Success status
   */
  async actionSetBackupMode(args) {
    try {
      const targetMode = args.mode === 'true';
      
      this.log(`Setting backup mode to: ${targetMode}`);
      await this.setCapabilityValue('backup_mode', targetMode);
      
      // Trigger the flow card if registered
      if (this.backupModeChangedTrigger) {
        await this.backupModeChangedTrigger.trigger(this, { mode: targetMode }, { mode: args.mode });
      }
      
      return true;
    } catch (error) {
      this.error('Error setting backup mode:', error);
      throw error;
    }
  }

  /**
   * Set force charge mode
   * @param {Object} args - Flow card arguments
   * @param {string} args.mode - Mode ID (none, force_charge, force_discharge, force_soc)
   * @returns {boolean} - Success status
   */
  async actionSetForceChargeMode(args) {
    try {
      this.log(`Setting force charge mode to: ${args.mode}`);
      await this.setCapabilityValue('force_charge_mode', args.mode);
      
      // Trigger the flow card if registered
      if (this.forceChargeModeChangedTrigger) {
        await this.forceChargeModeChangedTrigger.trigger(this, { mode: args.mode }, { mode: args.mode });
      }
      
      return true;
    } catch (error) {
      this.error('Error setting force charge mode:', error);
      throw error;
    }
  }

  /**
   * Set user work mode
   * @param {Object} args - Flow card arguments
   * @param {string} args.mode - Mode ID (manual, anti_feed, trade_mode, control_mode)
   * @returns {boolean} - Success status
   */
  async actionSetUserWorkMode(args) {
    try {
      this.log(`Setting user work mode to: ${args.mode}`);
      await this.setCapabilityValue('user_work_mode', args.mode);
      
      // Trigger the flow card if registered
      if (this.userWorkModeChangedTrigger) {
        await this.userWorkModeChangedTrigger.trigger(this, { mode: args.mode }, { mode: args.mode });
      }
      
      return true;
    } catch (error) {
      this.error('Error setting user work mode:', error);
      throw error;
    }
  }

  /**
   * Set force charge power
   * @param {Object} args - Flow card arguments
   * @param {number} args.power - Power setting in watts (0-2500)
   * @returns {boolean} - Success status
   */
  async actionSetForceChargePower(args) {
    try {
      const power = Number(args.power);
      
      // Validate range
      if (power < 0 || power > 2500) {
        throw new Error(`Invalid power value: ${power}W. Must be between 0-2500W`);
      }
      
      this.log(`Setting force charge power to: ${power}W`);
      await this.setCapabilityValue('force_charge_power', power);
      
      // Trigger the flow card if registered
      if (this.forceChargePowerChangedTrigger) {
        await this.forceChargePowerChangedTrigger.trigger(this, { power: power }, { power: power });
      }
      
      return true;
    } catch (error) {
      this.error('Error setting force charge power:', error);
      throw error;
    }
  }

  /**
   * Set force discharge power
   * @param {Object} args - Flow card arguments
   * @param {number} args.power - Power setting in watts (0-2500)
   * @returns {boolean} - Success status
   */
  async actionSetForceDischargePower(args) {
    try {
      const power = Number(args.power);
      
      // Validate range
      if (power < 0 || power > 2500) {
        throw new Error(`Invalid power value: ${power}W. Must be between 0-2500W`);
      }
      
      this.log(`Setting force discharge power to: ${power}W`);
      await this.setCapabilityValue('force_discharge_power', power);
      
      // Trigger the flow card if registered
      if (this.forceDischargePowerChangedTrigger) {
        await this.forceDischargePowerChangedTrigger.trigger(this, { power: power }, { power: power });
      }
      
      return true;
    } catch (error) {
      this.error('Error setting force discharge power:', error);
      throw error;
    }
  }

  /**
   * Set force charge target (SOC)
   * @param {Object} args - Flow card arguments
   * @param {number} args.target - SOC target in percentage (11-100)
   * @returns {boolean} - Success status
   */
  async actionSetForceChargeTarget(args) {
    try {
      const target = Number(args.target);
      
      // Validate range
      if (target < 11 || target > 100) {
        throw new Error(`Invalid SOC target: ${target}%. Must be between 11-100%`);
      }
      
      this.log(`Setting force charge target to: ${target}%`);
      await this.setCapabilityValue('force_charge_target', target);
      
      // Trigger the flow card if registered
      if (this.forceChargeTargetChangedTrigger) {
        await this.forceChargeTargetChangedTrigger.trigger(this, { target: target }, { target: target });
      }
      
      return true;
    } catch (error) {
      this.error('Error setting force charge target:', error);
      throw error;
    }
  }

  // ============================================
  // TRIGGER REGISTRATION
  // ============================================

  /**
   * Register flow card triggers in your device's onInit method
   */
  registerFlowCardTriggers() {
    // Register device-specific trigger cards

    this.forceChargeModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('force_charge_mode_changed');
    this.operationModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('operation_mode_changed');
    this.userWorkModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('user_work_mode_changed');
    this.forceChargePowerChangedTrigger = this.homey.flow.getDeviceTriggerCard('force_charge_power_changed');
    this.forceDischargePowerChangedTrigger = this.homey.flow.getDeviceTriggerCard('force_discharge_power_changed');
    this.forceChargeTargetChangedTrigger = this.homey.flow.getDeviceTriggerCard('force_charge_target_changed');
    
    this.log('Flow card triggers registered');
  }

  // ============================================
  // CAPABILITY CHANGE LISTENERS
  // ============================================

  /**
   * Set up capability change listeners to trigger flow cards automatically
   * Call this in your device's onInit method
   */
  setupCapabilityListeners() {
    // Listen for backup mode changes
    this.registerCapabilityListener('backup_mode', this.onCapabilityBackupMode.bind(this));
    // Listen for force charge mode changes
    this.registerCapabilityListener('force_charge_mode', this.onCapabilityChargeMode.bind(this));
    // Listen for user work mode changes
    this.registerCapabilityListener('user_work_mode', this.onCapabilityUserWorkMode.bind(this));
    // Listen for force charge power changes
    this.registerCapabilityListener('force_charge_power', this.onCapabilityForceChargePower.bind(this));
    // Listen for force discharge power changes
    this.registerCapabilityListener('force_discharge_power', this.onCapabilityForceDisChargePower.bind(this));
    // Listen for force charge target changes
    this.registerCapabilityListener('force_charge_target', this.onCapabilityForceChargeTarget.bind(this));
    // Listen for operation mode changes (read-only, triggered from data updates)
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
}

module.exports = VenusBatteryDevice;