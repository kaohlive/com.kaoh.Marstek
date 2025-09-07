'use strict';

const Homey = require('homey');

class VenusBatteryDriver extends Homey.Driver {

  INVERTER_MODES = {
    0: 'sleep',
    1: 'standby',
    2: 'charge',
    3: 'discharge',
    4: 'backup',
    5: 'update'
  };
  FORCE_MODES = {
    0: 'auto',
    1: 'force_charge',
    2: 'force_discharge'      
  };
  WORK_MODES = {
    0: 'manual',
    1: 'anti_feed',
    2: 'trade_mode'      
  };

  async onInit() {
    this.log('VenusBatteryDriver has been initialized');

    // Register flow card conditions
    this.registerFlowCardConditions();
    
    // Register flow card actions
    this.registerFlowCardActions();

  }


  registerFlowCardConditions() {
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
  }

  registerFlowCardActions() {
    // Set charge mode action
    this.homey.flow.getActionCard('set_charge_mode')
      .registerRunListener(async (args) => {
        return await args.device.actionSetChargeMode(args);
      });

    // Set target power action
    this.homey.flow.getActionCard('set_target_power')
      .registerRunListener(async (args) => {
        return await args.device.actionSetTargetPower(args);
      });
  }

  async onPairListDevices() {
    return [
      {
        name: 'Venus Battery System',
        data: {
          id: 'venus_battery_' + Math.random().toString(36).substr(2, 9)
        },
        settings: {
          ip: '192.168.1.100',
          port: 502,
          slave_id: 1,
          poll_interval: 5000
        }
      }
    ];
  }

}

module.exports = VenusBatteryDriver;