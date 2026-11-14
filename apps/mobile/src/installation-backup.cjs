const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

// Expo SecureStore's default exclusions cover its own keys. The application
// keeps all state local to this installation, including on device transfer.
module.exports = function withInstallationBackup(config) {
  config = withAndroidManifest(config, (config) => {
    config.modResults.manifest.application[0].$['android:dataExtractionRules'] = '@xml/teta_data_extraction_rules';
    return config;
  });
  return withDangerousMod(config, ['android', (config) => {
    const directory = join(config.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    mkdirSync(directory, { recursive: true });
    const exclusions = ['root', 'file', 'database', 'sharedpref', 'external'].map((domain) => `<exclude domain="${domain}" path="." />`).join('\n');
    writeFileSync(join(directory, 'teta_data_extraction_rules.xml'),
      `<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>
<cloud-backup>${exclusions}</cloud-backup>
<device-transfer>${exclusions}</device-transfer>
</data-extraction-rules>\n`);
    return config;
  }]);
};
