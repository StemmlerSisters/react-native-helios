import { NativeModules, Platform } from 'react-native';

const LINKING_ERROR =
  `The package 'react-native-helios' doesn't seem to be linked. Make sure: \n\n` +
  Platform.select({ ios: "- You have run 'pod install'\n", default: '' }) +
  '- You rebuilt the app after installing the package\n' +
  '- You are not using Expo Go\n';

const Helios = NativeModules.Helios
  ? NativeModules.Helios
  : new Proxy(
      {},
      {
        get() {
          throw new Error(LINKING_ERROR);
        },
      }
    );

export enum Network {
  MAINNET = 'MAINNET',
  GOERLI = 'GOERLI',
}

export type StartParams = {
  readonly network?: Network;
  readonly rpc_port?: number;
  readonly untrusted_rpc_url: string;
  readonly consensus_rpc_url: string;
};

export type StartResult = {
  readonly shutdown: () => Promise<void>;
};

export async function start({
  network: maybeNetwork,
  rpc_port: maybeRpcPort,
  ...extras
}: StartParams): Promise<StartResult> {
  const network =
    typeof maybeNetwork === 'string' ? maybeNetwork : Network.MAINNET;
  const rpc_port = typeof maybeRpcPort === 'number' ? maybeRpcPort : 8545;

  await Helios.start({ ...extras, rpc_port, network });

  const shutdown = async () => {
    await Helios.shutdown({ rpc_port });
  };

  return { shutdown };
}
