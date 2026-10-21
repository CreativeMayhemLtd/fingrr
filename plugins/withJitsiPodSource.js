// plugins/withJitsiPodSource.js
// Injects the Jitsi pod spec source into the generated Podfile.
// react-native-webrtc depends on JitsiWebRTC which is only in this repo.
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withJitsiPodSource(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) return cfg;

      let podfile = fs.readFileSync(podfilePath, 'utf8');

      const jitsiSource = "source 'https://github.com/jitsi/jitsi-meet-podspecs.git'";
      const cdnSource = "source 'https://cdn.cocoapods.org/'";

      // Only inject if not already present
      if (!podfile.includes('jitsi-meet-podspecs')) {
        // Insert before the first 'source' line, or at the top if none
        const firstSourceIdx = podfile.indexOf("source '");
        if (firstSourceIdx !== -1) {
          podfile =
            podfile.slice(0, firstSourceIdx) +
            jitsiSource + '\n' +
            podfile.slice(firstSourceIdx);
        } else {
          podfile = jitsiSource + '\n' + podfile;
        }
        fs.writeFileSync(podfilePath, podfile, 'utf8');
      }

      return cfg;
    },
  ]);
};
