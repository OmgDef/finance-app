import ExpoModulesCore
import Foundation

public class InstallationMarkerModule: Module {
  private func markerDirectory() throws -> URL {
    try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("TetaInstallation", isDirectory: true)
  }

  public func definition() -> ModuleDefinition {
    Name("InstallationMarker")

    AsyncFunction("exists") { () -> Bool in
      let marker = try self.markerDirectory().appendingPathComponent("initialized")
      return FileManager.default.fileExists(atPath: marker.path)
    }

    AsyncFunction("create") {
      var directory = try self.markerDirectory()
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try directory.setResourceValues(values)
      try Data().write(to: directory.appendingPathComponent("initialized"), options: .atomic)
    }
  }
}
