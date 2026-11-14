Pod::Spec.new do |s|
  s.name           = 'InstallationMarker'
  s.version        = '0.1.0'
  s.summary        = 'Device-local TэтаФинанс installation marker'
  s.description    = s.summary
  s.license        = { :type => 'UNLICENSED' }
  s.author         = 'TэтаФинанс'
  s.homepage       = 'https://example.invalid'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
