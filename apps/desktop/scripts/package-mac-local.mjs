import { packager } from "@electron/packager";

if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
  throw new Error(
    "Local macOS packaging requires an Apple Silicon or Intel Mac.",
  );
}
const arch = process.arch === "arm64" ? "arm64" : "x64";
const osxSign = {
  identity: "-",
  identityValidation: false,
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  continueOnError: false,
  optionsForFile: () => ({
    hardenedRuntime: false,
    entitlements: [],
  }),
};
const paths = await packager({
  dir: ".",
  name: "Molecule",
  platform: "darwin",
  arch,
  out: "release/local",
  asar: true,
  ignore: /^\/(src|scripts|node_modules|release)(\/|$)/,
  appBundleId: "ai.molecule.desktop",
  extendInfo: "Info.plist",
  osxSign,
});
console.info(
  `Local ad-hoc bundle (not for distribution):\n${paths.join("\n")}`,
);
