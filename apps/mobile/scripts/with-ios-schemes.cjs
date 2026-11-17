const { cp, mkdir, readFile, readdir, rm, writeFile, copyFile } = require('node:fs/promises');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const { IOSConfig, withFinalizedMod } = require('expo/config-plugins');
const plist = require('@expo/plist').default;
const sharp = createRequire(require.resolve('react-native-bootsplash/package.json'))('sharp');

const resourcesDirectory = 'SchemeResources';
const resourceRootSetting = 'TETA_IOS_RESOURCE_ROOT';
const imageCatalog = 'Images.xcassets';
const colorCatalog = 'Colors.xcassets';
const brandingFiles = [imageCatalog, colorCatalog, 'BootSplash.storyboard', 'Info.plist'];

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

async function prepareResources({ source, destination, projectRoot, variant, logoWidth }) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await Promise.all([...brandingFiles, 'Supporting'].map((file) =>
    cp(join(source, file), join(destination, file), { recursive: true })));

  // Use the catalogs and launch layout produced by Expo and BootSplash.
  const images = join(destination, imageCatalog);
  const iconSet = join(images, 'AppIcon.appiconset');
  const icon = JSON.parse(await readFile(join(iconSet, 'Contents.json'), 'utf8'));
  const iconFile = icon.images.find(({ filename }) => filename).filename;
  await copyFile(join(projectRoot, variant.assets, 'icon.png'), join(iconSet, iconFile));

  const logoSet = (await readdir(images)).find((entry) => entry.startsWith('BootSplashLogo-'));
  const logo = JSON.parse(await readFile(join(images, logoSet, 'Contents.json'), 'utf8'));
  await Promise.all(logo.images.map(({ filename, scale }) =>
    sharp(join(projectRoot, variant.assets, 'splash-logo.png'))
      .resize(logoWidth * Number.parseInt(scale, 10))
      .png().toFile(join(images, logoSet, filename))));

  const color = Object.fromEntries(['red', 'green', 'blue'].map((component, index) =>
    [component, String(Number.parseInt(variant.splashBackground.slice(1 + index * 2, 3 + index * 2), 16) / 255)]));
  const colors = join(destination, colorCatalog);
  const colorSet = (await readdir(colors)).find((entry) => entry.startsWith('BootSplashBackground-'));
  const colorFile = join(colors, colorSet, 'Contents.json');
  const colorDefinition = JSON.parse(await readFile(colorFile, 'utf8'));
  Object.assign(colorDefinition.colors[0].color.components, color);
  await writeJson(colorFile, colorDefinition);

  const storyboard = join(destination, 'BootSplash.storyboard');
  const launchScreen = await readFile(storyboard, 'utf8');
  await writeFile(storyboard, launchScreen.replace(
    /red="[^"]+" green="[^"]+" blue="[^"]+"/,
    `red="${color.red}" green="${color.green}" blue="${color.blue}"`,
  ));

  const infoFile = join(destination, 'Info.plist');
  const info = plist.parse(await readFile(infoFile, 'utf8'));
  for (const [key, value] of Object.entries(variant.infoPlist)) {
    if (value === null) delete info[key];
    else info[key] = value;
  }
  await writeFile(infoFile, plist.build(info));

  const localizedInfo = Object.entries(variant.russianInfo)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)};`).join('\n');
  await writeFile(join(destination, 'Supporting', 'ru.lproj', 'InfoPlist.strings'), localizedInfo + '\n');
}

function buildConfiguration(project, listId, name) {
  const configurations = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(project, listId);
  const existing = configurations.find(([, item]) => IOSConfig.XcodeUtils.unquote(item.name) === name);
  if (existing) return existing[1];

  const [, release] = IOSConfig.XcodeUtils.getBuildConfigurationForListIdAndName(project, {
    configurationListId: listId, buildConfiguration: 'Release',
  });
  const id = project.generateUuid();
  const configuration = { isa: release.isa, name, buildSettings: structuredClone(release.buildSettings) };
  const section = project.pbxXCBuildConfigurationSection();
  section[id] = configuration;
  section[id + '_comment'] = name;
  const list = project.pbxXCConfigurationList()[listId];
  list.buildConfigurations.push({ value: id, comment: name });
  return configuration;
}

function configureProject(project, { target, projectName, variants }) {
  const projectListId = project.getFirstProject().firstProject.buildConfigurationList;
  const configurations = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(project, projectListId);
  for (const [, configuration] of configurations) {
    configuration.buildSettings[resourceRootSetting] = '"$(SRCROOT)"';
  }
  for (const variant of variants) {
    const projectConfiguration = buildConfiguration(project, projectListId, variant.configuration);
    projectConfiguration.buildSettings[resourceRootSetting] =
      `"$(SRCROOT)/${resourcesDirectory}/${variant.name}"`;
    const targetConfiguration = buildConfiguration(project, target.buildConfigurationList, variant.configuration);
    targetConfiguration.buildSettings.INFOPLIST_FILE = `"$(${resourceRootSetting})/${projectName}/Info.plist"`;
    targetConfiguration.buildSettings.PRODUCT_NAME = variant.name;
  }

  const brandedPaths = new Set(brandingFiles.map((file) => `${projectName}/${file}`));
  for (const reference of Object.values(project.pbxFileReferenceSection())) {
    if (brandedPaths.has(reference.path)) reference.sourceTree = resourceRootSetting;
  }
  for (const group of Object.values(project.hash.project.objects.PBXGroup)) {
    if (group.path === `${projectName}/Supporting`) group.sourceTree = resourceRootSetting;
  }
}

async function writeSchemes(xcodeProject, projectName, targetId, variants) {
  const directory = join(xcodeProject, 'xcshareddata', 'xcschemes');
  const template = await readFile(join(directory, `${projectName}.xcscheme`), 'utf8');
  for (const { name, configuration } of variants) {
    const file = join(directory, `${name}.xcscheme`);
    const current = await readFile(file, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return template;
    });
    const scheme = current
      .replace(/<(?:Launch|Profile|Archive)Action\b[^>]*>/g, (action) =>
        action.replace(/buildConfiguration\s*=\s*"[^"]+"/, `buildConfiguration = "${configuration}"`))
      .replace(/<BuildableReference\b[^>]*>/g, (reference) =>
        new RegExp(`BlueprintIdentifier\\s*=\\s*"${targetId}"`).test(reference)
          ? reference.replace(/BuildableName\s*=\s*"[^"]+"/, `BuildableName = "${name}.app"`)
          : reference);
    await writeFile(file, scheme);
  }
}

module.exports = function withIosSchemes(config, { variants, logoWidth }) {
  return withFinalizedMod(config, ['ios', async (config) => {
    const { projectRoot, platformProjectRoot, projectName } = config.modRequest;
    const project = IOSConfig.XcodeUtils.getPbxproj(projectRoot);
    const { uuid, target } = IOSConfig.XcodeUtils.getApplicationNativeTarget({ project, projectName });
    await Promise.all(variants.map((variant) => prepareResources({
      source: join(platformProjectRoot, projectName),
      destination: join(platformProjectRoot, resourcesDirectory, variant.name, projectName),
      projectRoot, variant, logoWidth,
    })));
    configureProject(project, { target, projectName, variants });
    await writeFile(project.filepath, project.writeSync());
    await writeSchemes(IOSConfig.Paths.getXcodeProjectPath(projectRoot), projectName, uuid, variants);
    return config;
  }]);
};
