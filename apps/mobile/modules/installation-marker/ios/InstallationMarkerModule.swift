import ExpoModulesCore
import Foundation
import UIKit

public class InstallationMarkerModule: Module {
  private var protectingScenes = false
  private var privacyCovers: [ObjectIdentifier: UIView] = [:]

  private func markerDirectory() throws -> URL {
    try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("TetaInstallation", isDirectory: true)
  }

  public func definition() -> ModuleDefinition {
    Name("InstallationMarker")

    AsyncFunction("enableScenePrivacy") {
      guard !self.protectingScenes else { return }
      self.protectingScenes = true
      let center = NotificationCenter.default
      // Face ID can deactivate the scene without taking it to the background.
      center.addObserver(self, selector: #selector(self.coverScene(_:)),
                         name: UIScene.didEnterBackgroundNotification, object: nil)
      center.addObserver(self, selector: #selector(self.uncoverScene(_:)),
                         name: UIScene.didActivateNotification, object: nil)
      center.addObserver(self, selector: #selector(self.uncoverScene(_:)),
                         name: UIScene.didDisconnectNotification, object: nil)
    }.runOnQueue(.main)

    OnDestroy {
      NotificationCenter.default.removeObserver(self)
      DispatchQueue.main.async {
        self.privacyCovers.values.forEach { $0.removeFromSuperview() }
        self.privacyCovers.removeAll()
      }
    }

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

  @objc private func coverScene(_ notification: Notification) {
    guard let scene = notification.object as? UIWindowScene,
          let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else { return }
    let identifier = ObjectIdentifier(scene)
    guard privacyCovers[identifier] == nil else { return }

    let cover = UIView(frame: window.bounds)
    cover.backgroundColor = .systemBackground
    cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    window.addSubview(cover)
    privacyCovers[identifier] = cover
  }

  @objc private func uncoverScene(_ notification: Notification) {
    guard let scene = notification.object as? UIWindowScene else { return }
    privacyCovers.removeValue(forKey: ObjectIdentifier(scene))?.removeFromSuperview()
  }
}
