'use strict';

const Homey = require('homey');
const ModbusClient = require('../../api/ModbusClient');

class VenusBatteryDriver extends Homey.Driver {

  INVERTER_MODES = {
    0: 'sleep',
    1: 'standby',
    2: 'charge',
    3: 'discharge',
    4: 'backup',
    5: 'update',
    6: 'bypass'
  };
  FORCE_MODES = {
    0: 'none',
    1: 'force_charge',
    2: 'force_discharge'
  };
  WORK_MODES = {
    0: 'manual',
    1: 'anti_feed',
    2: 'trade_mode',
    3: 'control_mode'     
  };

  async onInit() {
    this.log('VenusBatteryDriver has been initialized');

    // Register flow card conditions
    this.registerFlowCardConditions();
    
    // Register flow card actions
    this.registerFlowCardActions();

  }


  registerFlowCardConditions() {
  // Existing conditions
  // Is charging condition
  this.homey.flow.getConditionCard('is_charging')
    .registerRunListener(async (args) => {
      return await args.device.conditionIsCharging();
    });

  // Is discharging condition
  this.homey.flow.getConditionCard('is_discharging')
    .registerRunListener(async (args) => {
      return await args.device.conditionIsDischarging();
    });

  // SOC above condition
  this.homey.flow.getConditionCard('soc_above')
    .registerRunListener(async (args) => {
      return await args.device.conditionSOCAbove(args);
    });

  // SOC below condition
  this.homey.flow.getConditionCard('soc_below')
    .registerRunListener(async (args) => {
      return await args.device.conditionSOCBelow(args);
    });

  // Operation mode is condition
  this.homey.flow.getConditionCard('operation_mode_is')
    .registerRunListener(async (args) => {
      return await args.device.conditionOperationModeIs(args);
    });

  // Has fault condition
  this.homey.flow.getConditionCard('has_fault')
    .registerRunListener(async (args) => {
      return await args.device.conditionHasFault();
    });

  // Temperature above condition
  this.homey.flow.getConditionCard('temperature_above')
    .registerRunListener(async (args) => {
      return await args.device.conditionTemperatureAbove(args);
    });

  // NEW CONDITIONS FROM CUSTOM CAPABILITIES
  // Battery backup mode is condition
  this.homey.flow.getConditionCard('backup_mode_is')
    .registerRunListener(async (args) => {
      return await args.device.conditionBackupModeIs(args);
    });

  // Force charge mode is condition
  this.homey.flow.getConditionCard('force_charge_mode_is')
    .registerRunListener(async (args) => {
      return await args.device.conditionForceChargeModeIs(args);
    });

  // User work mode is condition
  this.homey.flow.getConditionCard('user_work_mode_is')
    .registerRunListener(async (args) => {
      return await args.device.conditionUserWorkModeIs(args);
    });

  // Force charge power greater than condition
  this.homey.flow.getConditionCard('force_charge_power_greater_than')
    .registerRunListener(async (args) => {
      return await args.device.conditionForceChargePowerGreaterThan(args);
    });

  // Force discharge power greater than condition
  this.homey.flow.getConditionCard('force_discharge_power_greater_than')
    .registerRunListener(async (args) => {
      return await args.device.conditionForceDischargePowerGreaterThan(args);
    });

  // Force charge target greater than condition
  this.homey.flow.getConditionCard('force_charge_target_greater_than')
    .registerRunListener(async (args) => {
      return await args.device.conditionForceChargeTargetGreaterThan(args);
    });

  // Max charge power limit below condition
  this.homey.flow.getConditionCard('max_charge_power_limit_below')
    .registerRunListener(async (args) => {
      return await args.device.conditionMaxChargePowerLimitBelow(args);
    });

  // Max discharge power limit below condition
  this.homey.flow.getConditionCard('max_discharge_power_limit_below')
    .registerRunListener(async (args) => {
      return await args.device.conditionMaxDischargePowerLimitBelow(args);
    });

  // Charging cutoff SOC above condition
  this.homey.flow.getConditionCard('charging_cutoff_soc_above')
    .registerRunListener(async (args) => {
      return await args.device.conditionChargingCutoffSocAbove(args);
    });

  // Discharging cutoff SOC above condition
  this.homey.flow.getConditionCard('discharging_cutoff_soc_above')
    .registerRunListener(async (args) => {
      return await args.device.conditionDischargingCutoffSocAbove(args);
    });
}

registerFlowCardActions() {
  // Existing actions
  // Set charge mode action
  this.homey.flow.getActionCard('set_charge_mode')
    .registerRunListener(async (args) => {
      return await args.device.actionSetChargeMode(args);
    });


  // NEW ACTIONS FROM CUSTOM CAPABILITIES
  // Set backup mode action
  this.homey.flow.getActionCard('set_backup_mode')
    .registerRunListener(async (args) => {
      return await args.device.actionSetBackupMode(args);
    });

  // Set force charge mode action
  this.homey.flow.getActionCard('set_force_charge_mode')
    .registerRunListener(async (args) => {
      return await args.device.actionSetForceChargeMode(args);
    });

  // Set user work mode action
  this.homey.flow.getActionCard('set_user_work_mode')
    .registerRunListener(async (args) => {
      return await args.device.actionSetUserWorkMode(args);
    });

  // Set force charge power action
  this.homey.flow.getActionCard('set_force_charge_power')
    .registerRunListener(async (args) => {
      return await args.device.actionSetForceChargePower(args);
    });

  // Set force discharge power action
  this.homey.flow.getActionCard('set_force_discharge_power')
    .registerRunListener(async (args) => {
      return await args.device.actionSetForceDischargePower(args);
    });

  // Set force charge target action
  this.homey.flow.getActionCard('set_force_charge_target')
    .registerRunListener(async (args) => {
      return await args.device.actionSetForceChargeTarget(args);
    });

  // Set charging cutoff SOC action
  this.homey.flow.getActionCard('set_charging_cutoff_soc')
    .registerRunListener(async (args) => {
      return await args.device.actionSetChargingCutoffSoc(args);
    });

  // Set discharging cutoff SOC action
  this.homey.flow.getActionCard('set_discharging_cutoff_soc')
    .registerRunListener(async (args) => {
      return await args.device.actionSetDischargingCutoffSoc(args);
    });
}

  async onPair(session) {
    session.setHandler('test_connection', async (data) => {
      this.log(`Testing connection to ${data.ip}:${data.port} (slave ${data.slave_id})`);

      const client = new ModbusClient();
      try {
        const connected = await client.connect({ ip: data.ip, port: data.port });
        if (!connected) {
          return { success: false, message: 'Could not connect to device' };
        }

        // Try reading the device name register to verify the Marstek battery responds
        await client.readHoldingRegisters(data.slave_id, 31000, 1);
        client.disconnect();

        this.log('Connection test successful');
        return { success: true };
      } catch (err) {
        this.log('Connection test failed:', err.message);
        client.disconnect();
        return { success: false, message: err.message };
      }
    });
  }

}

module.exports = VenusBatteryDriver;