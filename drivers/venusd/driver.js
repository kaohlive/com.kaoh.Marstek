'use strict';

const Homey = require('homey');
const ModbusClient = require('../../api/ModbusClient');

// Marstek Venus D driver (also marketed by some resellers as "Duravolt").
//
// Venus D is a PV-hybrid battery. In v1.5.4 the driver was rewired to
// poll the same 32xxx/33xxx/35xxx/4xxxx register range as the Venus E
// driver: the community-extended Duravolt v1.1 datasheet confirms most
// of these addresses are shared. See drivers/venusd/device.js for the
// exclusion list (battery current/power, alarms, PV) and rationale.

class VenusDDriver extends Homey.Driver {

  // Same enums as Venus E - Duravolt v1.1 protocol shares these mappings.
  INVERTER_MODES = {
    0: 'sleep',
    1: 'standby',
    2: 'charge',
    3: 'discharge',
    4: 'backup',
    5: 'update',
    6: 'bypass',
  };
  FORCE_MODES = {
    0: 'none',
    1: 'force_charge',
    2: 'force_discharge',
  };
  WORK_MODES = {
    0: 'manual',
    1: 'anti_feed',
    2: 'trade_mode',
    3: 'control_mode',
  };

  async onInit() {
    this.log('VenusDDriver has been initialized');
    this.registerFlowCardConditions();
    this.registerFlowCardActions();
  }

  registerFlowCardConditions() {
    this.homey.flow.getConditionCard('is_charging')
      .registerRunListener(async (args) => args.device.conditionIsCharging());
    this.homey.flow.getConditionCard('is_discharging')
      .registerRunListener(async (args) => args.device.conditionIsDischarging());
    this.homey.flow.getConditionCard('soc_above')
      .registerRunListener(async (args) => args.device.conditionSOCAbove(args));
    this.homey.flow.getConditionCard('soc_below')
      .registerRunListener(async (args) => args.device.conditionSOCBelow(args));
    this.homey.flow.getConditionCard('operation_mode_is')
      .registerRunListener(async (args) => args.device.conditionOperationModeIs(args));
    this.homey.flow.getConditionCard('temperature_above')
      .registerRunListener(async (args) => args.device.conditionTemperatureAbove(args));
    this.homey.flow.getConditionCard('backup_mode_is')
      .registerRunListener(async (args) => args.device.conditionBackupModeIs(args));
    this.homey.flow.getConditionCard('force_charge_mode_is')
      .registerRunListener(async (args) => args.device.conditionForceChargeModeIs(args));
    this.homey.flow.getConditionCard('user_work_mode_is')
      .registerRunListener(async (args) => args.device.conditionUserWorkModeIs(args));
    this.homey.flow.getConditionCard('force_charge_power_greater_than')
      .registerRunListener(async (args) => args.device.conditionForceChargePowerGreaterThan(args));
    this.homey.flow.getConditionCard('force_discharge_power_greater_than')
      .registerRunListener(async (args) => args.device.conditionForceDischargePowerGreaterThan(args));
    this.homey.flow.getConditionCard('force_charge_target_greater_than')
      .registerRunListener(async (args) => args.device.conditionForceChargeTargetGreaterThan(args));
    this.homey.flow.getConditionCard('max_charge_power_limit_below')
      .registerRunListener(async (args) => args.device.conditionMaxChargePowerLimitBelow(args));
    this.homey.flow.getConditionCard('max_discharge_power_limit_below')
      .registerRunListener(async (args) => args.device.conditionMaxDischargePowerLimitBelow(args));
    this.homey.flow.getConditionCard('charging_cutoff_soc_above')
      .registerRunListener(async (args) => args.device.conditionChargingCutoffSocAbove(args));
    this.homey.flow.getConditionCard('discharging_cutoff_soc_above')
      .registerRunListener(async (args) => args.device.conditionDischargingCutoffSocAbove(args));
  }

  registerFlowCardActions() {
    this.homey.flow.getActionCard('set_charge_mode')
      .registerRunListener(async (args) => args.device.actionSetChargeMode(args));
    this.homey.flow.getActionCard('set_backup_mode')
      .registerRunListener(async (args) => args.device.actionSetBackupMode(args));
    this.homey.flow.getActionCard('set_force_charge_mode')
      .registerRunListener(async (args) => args.device.actionSetForceChargeMode(args));
    this.homey.flow.getActionCard('set_user_work_mode')
      .registerRunListener(async (args) => args.device.actionSetUserWorkMode(args));
    this.homey.flow.getActionCard('set_force_charge_power')
      .registerRunListener(async (args) => args.device.actionSetForceChargePower(args));
    this.homey.flow.getActionCard('set_force_discharge_power')
      .registerRunListener(async (args) => args.device.actionSetForceDischargePower(args));
    this.homey.flow.getActionCard('set_force_charge_target')
      .registerRunListener(async (args) => args.device.actionSetForceChargeTarget(args));
    this.homey.flow.getActionCard('set_charging_cutoff_soc')
      .registerRunListener(async (args) => args.device.actionSetChargingCutoffSoc(args));
    this.homey.flow.getActionCard('set_discharging_cutoff_soc')
      .registerRunListener(async (args) => args.device.actionSetDischargingCutoffSoc(args));
  }

  async onPair(session) {
    session.setHandler('test_connection', async (data) => {
      this.log(`Testing Venus D connection to ${data.ip}:${data.port} (slave ${data.slave_id})`);

      const client = new ModbusClient();
      try {
        const connected = await client.connect({ ip: data.ip, port: data.port });
        if (!connected) {
          return { success: false, message: 'Could not connect to device' };
        }

        const reg_name = await client.readHoldingRegisters(data.slave_id, 31000, 10);
        const deviceName = ModbusClient.bufferToString(reg_name).trim();
        const lower = deviceName.toLowerCase();

        await client.disconnect();

        // Reject Venus E / V3 / V1-V2 hardware that should be on the venus
        // driver. Permissive for anything else: if the user explicitly picked
        // Venus D, trust them.
        if (lower.startsWith('vnse') || lower.startsWith('ac') || lower.startsWith('limited') || lower.includes('bi_')) {
          return {
            success: false,
            message: `This device identifies as "${deviceName}" which is a Venus E / V3 / V1-V2 - please pair it with the "Venus E" driver instead, not the Venus D driver.`,
          };
        }

        this.log(`Connection test successful: detected "${deviceName}"`);
        return { success: true, deviceName };
      } catch (err) {
        this.log('Connection test failed:', err.message);
        await client.disconnect().catch(() => {});
        return { success: false, message: err.message };
      }
    });
  }
}

module.exports = VenusDDriver;
