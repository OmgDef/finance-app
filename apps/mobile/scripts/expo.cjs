const { execFile } = require('node:child_process');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');

const expo = require.resolve('expo/bin/cli');

if (process.platform === 'darwin') {
  const requireFromExpo = createRequire(expo);
  const { AppleDeviceManager } = requireFromExpo('@expo/cli/build/src/start/platforms/ios/AppleDeviceManager.js');
  const exec = promisify(execFile);

  // Expo already boots the device and opens the app via simctl. Use Launch Services
  // to show its window, so denied Apple Events don't interrupt the launch.
  AppleDeviceManager.prototype.activateWindowAsync = async function () {
    try {
      await exec('/usr/bin/open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', this.identifier]);
    } catch {
      // Xcode 27 uses Device Hub in place of Simulator.app.
      try {
        await exec('/usr/bin/open', [`devices://device/open?id=${this.identifier}`]);
      } catch (error) {
        console.warn(`Could not show the iOS simulator window: ${error.message}`);
      }
    }
  };
}

require(expo);
