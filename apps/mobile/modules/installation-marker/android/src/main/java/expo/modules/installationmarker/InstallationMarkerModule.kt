package expo.modules.installationmarker

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class InstallationMarkerModule : Module() {
  private fun marker(): File {
    val context = checkNotNull(appContext.reactContext)
    return File(context.noBackupFilesDir, "teta-installation")
  }

  override fun definition() = ModuleDefinition {
    Name("InstallationMarker")

    AsyncFunction("exists") {
      marker().isFile
    }

    AsyncFunction("create") {
      marker().createNewFile()
      Unit
    }
  }
}
