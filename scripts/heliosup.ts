import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';

const RUST_VERSION_LATEST = 'nightly';
const name = 'helios';
const helios_checksum = '4c72344b55991b6296ccbb12b3c9e3ad634d593e';
const openssl_sys_checksum = 'b30313a9775ed861ce9456745952e3012e5602ea';
const stdio = 'inherit';
const build = path.resolve('build');

const helios = path.resolve(build, name);
const helios_toml = path.resolve(helios, 'Cargo.toml');

const rust_openssl = path.resolve(build, 'openssl');
const openssl_sys = path.resolve(rust_openssl, 'openssl-sys');

abstract class HeliosFactory {
  private static prepareBuildDir(): void {
    fs.existsSync(build) && fs.rmSync(build, { recursive: true });
    fs.mkdirSync(build);
  }

  private static checkoutHelios(): void {
    child_process.execSync('git clone https://github.com/a16z/helios', {
      cwd: build,
      stdio,
    });
    child_process.execSync(`git reset --hard ${helios_checksum}`, {
      stdio,
      cwd: helios,
    });
  }

  private static checkoutOpenSsl(): void {
    child_process.execSync(
      `git clone https://github.com/sfackler/rust-openssl ${rust_openssl}`,
      { stdio }
    );

    child_process.execSync(`git checkout ${openssl_sys_checksum}`, {
      stdio,
      cwd: openssl_sys,
    });

    const openssl_sys_toml = path.resolve(openssl_sys, 'Cargo.toml');

    fs.writeFileSync(
      openssl_sys_toml,
      fs
        .readFileSync(openssl_sys_toml, 'utf-8')
        .split('\n')
        .flatMap((e) => {
          if (e.startsWith('openssl-src'))
            return ['openssl-src = { version = "300", optional = true }'];

          return [e];
        })
        .join('\n')
    );
  }

  protected constructor() {}

  protected abstract getTargets(): readonly string[];
  protected abstract getCargoDependencies(): readonly string[];
  protected abstract getLibrarySource(): readonly string[];
  protected abstract getCrateType(): string;
  protected abstract customizeCargo(
    current: readonly string[]
  ): readonly string[];
  protected abstract getBuildScriptSource(): readonly string[];
  protected abstract handleBuildCompletion(): void;

  public compile(): void {
    HeliosFactory.prepareBuildDir();

    const rust_version = RUST_VERSION_LATEST;

    child_process.execSync('rustup default stable', { cwd: build, stdio });

    child_process.execSync(`rustup install ${rust_version}`, {
      cwd: build,
      stdio,
    });

    child_process.execSync(`rustup default ${rust_version}`, {
      cwd: build,
      stdio,
    });

    child_process.execSync('rustup --version', { cwd: build, stdio });

    child_process.execSync(`rustup target add ${this.getTargets().join(' ')}`, {
      stdio,
      cwd: build,
    });

    child_process.execSync(
      `cargo install ${this.getCargoDependencies().join(' ')}`,
      {
        cwd: build,
        stdio,
      }
    );

    HeliosFactory.checkoutHelios();
    HeliosFactory.checkoutOpenSsl();

    const src = path.resolve(helios, 'src');
    const lib_rs = path.resolve(src, 'lib.rs');

    fs.writeFileSync(lib_rs, this.getLibrarySource().join('\n'));

    fs.writeFileSync(
      helios_toml,
      [
        ...fs
          .readFileSync(helios_toml, 'utf-8')
          .split('\n')
          .flatMap((str) => {
            // HACK: Override to use a version of OpenSSL which is
            //       compatible with the iOS Simulator.
            if (str === '[patch.crates-io]')
              return [str, `openssl-sys = { path = "${openssl_sys}" }`];

            return [str];
          }),
        '',
        '[lib]',
        `name = "${name}"`,
        `crate-type = ["${this.getCrateType()}"]`,
      ].join('\n')
    );

    fs.writeFileSync(
      helios_toml,
      this.customizeCargo(
        fs.readFileSync(helios_toml, 'utf-8').split('\n')
      ).join('\n')
    );

    const build_sh = path.resolve(helios, 'build.sh');
    fs.writeFileSync(build_sh, this.getBuildScriptSource().join('\n'));

    child_process.execSync(`chmod +x ${build_sh}`, { stdio, cwd: helios });
    child_process.execSync(build_sh, { stdio, cwd: helios });

    child_process.execSync('rustup default stable', { cwd: build, stdio });

    this.handleBuildCompletion();
  }
}

class AppleHeliosFactory extends HeliosFactory {
  private static preparePackageBuild() {
    fs.writeFileSync(
      path.resolve(helios, 'build.rs'),
      [
        'use std::path::PathBuf;',
        '',
        'fn main() {',
        '  let out_dir = PathBuf::from("./generated");',
        '  let bridges = vec!["src/lib.rs"];',
        '  for path in &bridges {',
        '    println!("cargo:rerun-if-changed={}", path);',
        '  }',
        '  swift_bridge_build::parse_bridges(bridges)',
        '    .write_all_concatenated(out_dir, env!("CARGO_PKG_NAME"));',
        '}',
      ].join('\n')
    );
  }
  constructor() {
    super();
  }
  protected getTargets(): readonly string[] {
    return ['aarch64-apple-ios', 'x86_64-apple-ios', 'aarch64-apple-ios-sim'];
  }
  protected getCargoDependencies(): readonly string[] {
    return ['cargo-lipo'];
  }
  protected getLibrarySource(): readonly string[] {
    return [
      'use std::collections::HashMap;',
      'use std::ffi::{CStr, CString};',
      '',
      'use ::client::{database::FileDB, Client, ClientBuilder};',
      'use ::config::{CliConfig, Config, networks};',
      '',
      '#[swift_bridge::bridge]',
      'mod ffi {',
      '',
      '  extern "Rust" {',
      '    type RustApp;',
      '',
      '    #[swift_bridge(init)]',
      '    fn new() -> RustApp;',
      '',
      '    async fn helios_start(&mut self, untrusted_rpc_url: String, consensus_rpc_url: String);',
      '    async fn helios_get_block_number(&mut self) -> String;',
      '  }',
      '}',
      '',
      'impl RustApp {',
      '',
      '  pub fn new() -> Self {',
      '    RustApp {',
      '      client: None,',
      '    }',
      '}',
      '',
      '  async fn helios_start(',
      '    &mut self,',
      '    untrusted_rpc_url: String,',
      '    consensus_rpc_url: String',
      '  ) {',
      '    let mut client = ClientBuilder::new()',
      '      .network(networks::Network::MAINNET)',
      '      .consensus_rpc(&consensus_rpc_url)',
      '      .execution_rpc(&untrusted_rpc_url)',
      '      .rpc_port(8545)',
      '      .build()',
      '      .unwrap();',
      '',
      '    client.start().await.unwrap();',
      '',
      '    self.client = Some(client);',
      '  }',
      '',
      '  async fn helios_get_block_number(&mut self) -> String {',
      '    if let Some(client) = &self.client {',
      '      return client.get_block_number().await.unwrap().to_string();',
      '    }',
      '    return (-1).to_string();',
      '  }',
      '',
      '}',
      '',
      'pub struct RustApp {',
      '  client: Option<Client<FileDB>>,',
      '}',
    ];
  }
  protected getCrateType(): string {
    return 'staticlib';
  }
  protected customizeCargo(current: readonly string[]): readonly string[] {
    return current.flatMap((str) => {
      if (str === '[dependencies]') {
        return [
          '[build-dependencies]',
          'swift-bridge-build = "0.1"',
          '',
          str,
          'swift-bridge = {version = "0.1", features = ["async"]}',
        ];
      } else if (str === '[package]') return [str, 'build = "build.rs"'];
      return [str];
    });
  }

  protected getBuildScriptSource(): readonly string[] {
    AppleHeliosFactory.preparePackageBuild();
    return [
      '#!/bin/bash',
      '',
      'set -e',
      '',
      'THISDIR=$(dirname $0)',
      'cd $THISDIR',
      'export SWIFT_BRIDGE_OUT_DIR="$(pwd)/generated"',
      '',

      // https://gist.github.com/surpher/bbf88e191e9d1f01ab2e2bbb85f9b528#universal-ios-arm64-mobile-device--x86_64-simulator
      'cargo lipo --release',
      // https://gist.github.com/surpher/bbf88e191e9d1f01ab2e2bbb85f9b528#ios-simulator-arm64
      'cargo build -Z build-std --target aarch64-apple-ios-sim --release',
    ];
  }
  protected handleBuildCompletion() {
    const generated = path.resolve(helios, 'generated');
    const generated_helios_h = path.resolve(generated, name, `${name}.h`);
    const generated_helios_swift = path.resolve(
      generated,
      name,
      `${name}.swift`
    );
    const generated_swift_bridge_h = path.resolve(
      generated,
      'SwiftBridgeCore.h'
    );
    const generated_swift_bridge_swift = path.resolve(
      generated,
      'SwiftBridgeCore.swift'
    );

    const result_h = [
      ...fs.readFileSync(generated_swift_bridge_h, 'utf-8').split('\n'),
      // HACK: For now we'll remove generated #imports since we assume they'll be included
      //       by generated_swift_bridge_h.
      ...fs
        .readFileSync(generated_helios_h, 'utf-8')
        .split('\n')
        .filter((e) => !e.startsWith('#include')),
    ].join('\n');

    const header = path.resolve(helios, `lib${name}.h`);
    const library = path.resolve(helios, 'SwiftBridgeCore.swift');

    fs.writeFileSync(
      library,
      `
${fs.readFileSync(generated_swift_bridge_swift, 'utf-8')}

${fs
  .readFileSync(generated_helios_swift, 'utf-8')
  .split('\n')
  // HACK: Annotate async methods with the available annotation.
  .flatMap((str) => {
    if (!str.startsWith('extension')) return [str];
    return ['@available(iOS 13.0.0, *)', str];
  })
  .join('\n')}
  `.trim()
    );

    fs.writeFileSync(header, result_h);

    const deviceStaticLib = path.resolve(
      helios,
      'target',
      'aarch64-apple-ios',
      'release',
      `lib${name}.a`
    );

    const simulatorStaticlib = path.resolve(
      helios,
      'target',
      'aarch64-apple-ios-sim',
      'release',
      `lib${name}.a`
    );

    const appleStaticLibs = [deviceStaticLib, simulatorStaticlib];

    const ios = path.resolve('ios');

    const xcframework = path.resolve(helios, `lib${name}.xcframework`);

    child_process.execSync(
      `xcodebuild -create-xcframework ${appleStaticLibs
        .map((e) => `-library ${e} -headers ${header}`)
        .join(' ')} -output ${xcframework}`,
      { stdio, cwd: helios }
    );

    const target_xcworkspace = path.resolve(ios, path.basename(xcframework));

    if (fs.existsSync(target_xcworkspace))
      fs.rmSync(target_xcworkspace, { recursive: true });

    fs.renameSync(xcframework, target_xcworkspace);

    fs.copyFileSync(library, path.resolve(ios, path.basename(library)));

    // TODO: maybe it's unncessary to include headers within the framework declaration
    fs.copyFileSync(header, path.resolve(ios, path.basename(header)));
  }
}

class AndroidHeliosFactory extends HeliosFactory {
  constructor() {
    super();
  }
  protected getTargets(): readonly string[] {
    return [
      'aarch64-linux-android',
      'armv7-linux-androideabi',
      'i686-linux-android',
      'x86_64-linux-android',
    ];
  }
  protected getCargoDependencies(): readonly string[] {
    return ['cargo-ndk'];
  }
  protected getLibrarySource(): readonly string[] {
    throw new Error('[getLibrarySource]: Method stub.');
  }
  protected getCrateType(): string {
    return 'cdylib';
  }
  protected customizeCargo(current: readonly string[]): readonly string[] {
    throw new Error('[customizeCargo]: Method stub.');
  }
  protected getBuildScriptSource(): readonly string[] {
    throw new Error('[getBuildScriptSource]: Method stub.');
  }
  protected handleBuildCompletion() {
    throw new Error('[handleBuildCompletion]: Method stub.');
  }
}

void (async () => {
  try {
    new AppleHeliosFactory().compile();

    // Sync up the example app.
    child_process.execSync(
      'rm -rf node_modules ; rm yarn.lock ; yarn add ../',
      {
        stdio,
        cwd: path.resolve('example'),
      }
    );

    // Ensure pods are up to date.
    child_process.execSync('pod install', {
      stdio,
      cwd: path.resolve('example', 'ios'),
    });
  } catch (e) {
    console.error(e);
  }
})();
