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
//
// Flow card runListeners are registered ONCE by the Venus E driver
// (drivers/venus/driver.js), which owns the shared card definitions
// stored at app-level in .homeycompose/flow/. Each shared card carries
// filter="driver_id=venus|driver_id=venusd" so both drivers' devices
// appear as flow targets; alarm-related cards keep filter="driver_id=
// venus" only, since Venus D deliberately does not process alarms.

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
