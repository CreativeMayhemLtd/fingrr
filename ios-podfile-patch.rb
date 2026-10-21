# ios-podfile-patch.rb — applied by EAS via expo-build-properties
# Overrides the JitsiWebRTC source to use CDN and increases timeout.
# This prevents the "Install dependencies" timeout on EAS builders.
#
# Usage: expo install expo-build-properties
# Then in app.json plugins:
#   ["expo-build-properties", { "ios": { "extraPodfileHeadContent": "..." } }]
# (see app.json)

require 'cocoapods-acknowledgements'

# Allow longer network operations for JitsiWebRTC (~200MB)
ENV['COCOAPODS_DISABLE_STATS'] = '1'
