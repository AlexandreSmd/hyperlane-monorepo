import { Contract, PopulatedTransaction, ethers } from 'ethers';
import { Logger } from 'pino';

import {
  IPostDispatchHook,
  IPostDispatchHook__factory,
  ITransparentUpgradeableProxy,
  MailboxClient,
  Ownable,
  ProxyAdmin,
  ProxyAdmin__factory,
  TimelockController,
  TimelockController__factory,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';
import SdkBuildArtifact from '@hyperlane-xyz/core/buildArtifact.json';
import {
  Address,
  ProtocolType,
  eqAddress,
  rootLogger,
  runWithTimeout,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
} from '../contracts/types';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { IsmConfig } from '../ism/types';
import { moduleMatchesConfig } from '../ism/utils';
import { MultiProvider } from '../providers/MultiProvider';
import { MailboxClientConfig } from '../router/types';
import { ChainMap, ChainName } from '../types';

import {
  UpgradeConfig,
  isProxy,
  proxyAdmin,
  proxyConstructorArgs,
  proxyImplementation,
} from './proxy';
import { OwnableConfig } from './types';
import { ContractVerifier } from './verify/ContractVerifier';
import { ContractVerificationInput, ExplorerLicenseType } from './verify/types';
import {
  buildVerificationInput,
  getContractVerificationInput,
} from './verify/utils';

export interface DeployerOptions {
  logger?: Logger;
  chainTimeoutMs?: number;
  ismFactory?: HyperlaneIsmFactory;
  contractVerifier?: ContractVerifier;
}

export abstract class HyperlaneDeployer<
  Config extends object,
  Factories extends HyperlaneFactories,
> {
  public verificationInputs: ChainMap<ContractVerificationInput[]> = {};
  public cachedAddresses: HyperlaneAddressesMap<any> = {};
  public deployedContracts: HyperlaneContractsMap<Factories> = {};
  public startingBlockNumbers: ChainMap<number | undefined> = {};

  protected logger: Logger;
  protected chainTimeoutMs: number;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly factories: Factories,
    protected readonly options: DeployerOptions = {},
    protected readonly recoverVerificationInputs = false,
  ) {
    this.logger = options?.logger ?? rootLogger.child({ module: 'deployer' });
    this.chainTimeoutMs = options?.chainTimeoutMs ?? 5 * 60 * 1000; // 5 minute timeout per chain
    this.options.ismFactory?.setDeployer(this);

    // if none provided, instantiate a default verifier with SDK's included build artifact
    this.options.contractVerifier ??= new ContractVerifier(
      multiProvider,
      {},
      SdkBuildArtifact,
      ExplorerLicenseType.MIT,
    );
  }

  cacheAddressesMap(addressesMap: HyperlaneAddressesMap<any>): void {
    this.cachedAddresses = addressesMap;
  }

  abstract deployContracts(
    chain: ChainName,
    config: Config,
  ): Promise<HyperlaneContracts<Factories>>;

  async deploy(
    configMap: ChainMap<Config>,
  ): Promise<HyperlaneContractsMap<Factories>> {
    const configChains = Object.keys(configMap);
    const ethereumConfigChains = configChains.filter(
      (chain) =>
        this.multiProvider.getChainMetadata(chain).protocol ===
        ProtocolType.Ethereum,
    );

    const targetChains = this.multiProvider.intersect(
      ethereumConfigChains,
      true,
    ).intersection;

    this.logger.debug(`Start deploy to ${targetChains}`);
    for (const chain of targetChains) {
      const signerUrl = await this.multiProvider.tryGetExplorerAddressUrl(
        chain,
      );
      const signerAddress = await this.multiProvider.getSignerAddress(chain);
      const fromString = signerUrl || signerAddress;
      this.logger.info(`Deploying to ${chain} from ${fromString}`);
      this.startingBlockNumbers[chain] = await this.multiProvider
        .getProvider(chain)
        .getBlockNumber();
      await runWithTimeout(this.chainTimeoutMs, async () => {
        const contracts = await this.deployContracts(chain, configMap[chain]);
        this.addDeployedContracts(chain, contracts);
      });
    }
    return this.deployedContracts;
  }

  protected addDeployedContracts(
    chain: ChainName,
    contracts: HyperlaneContracts<any>,
    verificationInputs?: ContractVerificationInput[],
  ): void {
    this.deployedContracts[chain] = {
      ...this.deployedContracts[chain],
      ...contracts,
    };
    if (verificationInputs)
      this.addVerificationArtifacts(chain, verificationInputs);
  }

  protected addVerificationArtifacts(
    chain: ChainName,
    artifacts: ContractVerificationInput[],
  ): void {
    this.verificationInputs[chain] = this.verificationInputs[chain] || [];
    artifacts.forEach((artifact) => {
      this.verificationInputs[chain].push(artifact);
    });

    // TODO: deduplicate
  }

  protected async runIf<T>(
    chain: ChainName,
    address: string,
    fn: () => Promise<T>,
    label = 'address',
  ): Promise<T | undefined> {
    const signer = await this.multiProvider.getSignerAddress(chain);
    if (eqAddress(address, signer)) {
      return fn();
    } else {
      this.logger.debug(
        `Signer (${signer}) does not match ${label} (${address})`,
      );
    }
    return undefined;
  }

  protected async runIfOwner<T>(
    chain: ChainName,
    ownable: Ownable,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    return this.runIf(chain, await ownable.callStatic.owner(), fn, 'owner');
  }

  protected async runIfAdmin<T>(
    chain: ChainName,
    proxy: Contract,
    signerAdminFn: () => Promise<T>,
    proxyAdminOwnerFn: (proxyAdmin: ProxyAdmin) => Promise<T>,
  ): Promise<T | undefined> {
    const admin = await proxyAdmin(
      this.multiProvider.getProvider(chain),
      proxy.address,
    );
    const code = await this.multiProvider.getProvider(chain).getCode(admin);
    // if admin is a ProxyAdmin, run the proxyAdminOwnerFn (if deployer is owner)
    if (code !== '0x') {
      this.logger.debug(`Admin is a ProxyAdmin (${admin})`);
      const proxyAdmin = ProxyAdmin__factory.connect(admin, proxy.signer);
      return this.runIfOwner(chain, proxyAdmin, () =>
        proxyAdminOwnerFn(proxyAdmin),
      );
    } else {
      this.logger.debug(`Admin is an EOA (${admin})`);
      // if admin is an EOA, run the signerAdminFn (if deployer is admin)
      return this.runIf(chain, admin, () => signerAdminFn(), 'admin');
    }
  }

  protected async configureIsm<C extends Ownable>(
    chain: ChainName,
    contract: C,
    config: IsmConfig,
    getIsm: (contract: C) => Promise<Address>,
    setIsm: (contract: C, ism: Address) => Promise<PopulatedTransaction>,
  ): Promise<void> {
    const configuredIsm = await getIsm(contract);
    let matches = false;
    let targetIsm: Address;
    if (typeof config === 'string') {
      if (eqAddress(configuredIsm, config)) {
        matches = true;
      } else {
        targetIsm = config;
      }
    } else {
      const ismFactory =
        this.options.ismFactory ??
        (() => {
          throw new Error('No ISM factory provided');
        })();

      matches = await moduleMatchesConfig(
        chain,
        configuredIsm,
        config,
        this.multiProvider,
        ismFactory.getContracts(chain),
      );
      targetIsm = (await ismFactory.deploy({ destination: chain, config }))
        .address;
    }
    if (!matches) {
      await this.runIfOwner(chain, contract, async () => {
        this.logger.debug(`Set ISM on ${chain} with address ${targetIsm}`);
        await this.multiProvider.sendTransaction(
          chain,
          setIsm(contract, targetIsm),
        );
        if (!eqAddress(targetIsm, await getIsm(contract))) {
          throw new Error(`Set ISM failed on ${chain}`);
        }
      });
    }
  }

  protected async configureHook<C extends Ownable>(
    chain: ChainName,
    contract: C,
    targetHook: IPostDispatchHook,
    getHook: (contract: C) => Promise<Address>,
    setHook: (contract: C, hook: Address) => Promise<PopulatedTransaction>,
  ): Promise<void> {
    const configuredHook = await getHook(contract);
    if (!eqAddress(targetHook.address, configuredHook)) {
      const result = await this.runIfOwner(chain, contract, async () => {
        this.logger.debug(
          `Set hook on ${chain} to ${targetHook.address}, currently is ${configuredHook}`,
        );
        await this.multiProvider.sendTransaction(
          chain,
          setHook(contract, targetHook.address),
        );
        const actualHook = await getHook(contract);
        if (!eqAddress(targetHook.address, actualHook)) {
          throw new Error(
            `Set hook failed on ${chain}, wanted ${targetHook.address}, got ${actualHook}`,
          );
        }
        return true;
      });
      // if the signer is not the owner, saving the hook address in the artifacts for later use for sending test messages, etc
      if (!result) {
        this.addDeployedContracts(chain, { customHook: targetHook });
      }
    }
  }

  protected async configureClient(
    local: ChainName,
    client: MailboxClient,
    config: MailboxClientConfig,
  ): Promise<void> {
    this.logger.debug(
      `Initializing mailbox client (if not already) on ${local}...`,
    );
    if (config.hook) {
      await this.configureHook(
        local,
        client,
        IPostDispatchHook__factory.connect(
          config.hook,
          this.multiProvider.getSignerOrProvider(local),
        ),
        (_client) => _client.hook(),
        (_client, _hook) => _client.populateTransaction.setHook(_hook),
      );
    }

    if (config.interchainSecurityModule) {
      await this.configureIsm(
        local,
        client,
        config.interchainSecurityModule,
        (_client) => _client.interchainSecurityModule(),
        (_client, _module) =>
          _client.populateTransaction.setInterchainSecurityModule(_module),
      );
    }

    this.logger.debug(`Mailbox client on ${local} initialized...`);
  }

  public async deployContractFromFactory<F extends ethers.ContractFactory>(
    chain: ChainName,
    factory: F,
    contractName: string,
    constructorArgs: Parameters<F['deploy']>,
    initializeArgs?: Parameters<Awaited<ReturnType<F['deploy']>>['initialize']>,
    shouldRecover = true,
  ): Promise<ReturnType<F['deploy']>> {
    if (shouldRecover) {
      const cachedContract = this.readCache(chain, factory, contractName);
      if (cachedContract) {
        if (this.recoverVerificationInputs) {
          const recoveredInputs = await this.recoverVerificationArtifacts(
            chain,
            contractName,
            cachedContract,
            constructorArgs,
            initializeArgs,
          );
          this.addVerificationArtifacts(chain, recoveredInputs);
        }
        return cachedContract;
      }
    }

    this.logger.info(
      `Deploy ${contractName} on ${chain} with constructor args (${constructorArgs.join(
        ', ',
      )})`,
    );
    const contract = await this.multiProvider.handleDeploy(
      chain,
      factory,
      constructorArgs,
    );

    if (initializeArgs) {
      this.logger.debug(`Initialize ${contractName} on ${chain}`);
      const overrides = this.multiProvider.getTransactionOverrides(chain);
      const initTx = await contract.initialize(...initializeArgs, overrides);
      await this.multiProvider.handleTx(chain, initTx);
    }

    const verificationInput = getContractVerificationInput(
      contractName,
      contract,
      factory.bytecode,
    );
    this.addVerificationArtifacts(chain, [verificationInput]);

    // try verifying contract
    try {
      await this.options.contractVerifier?.verifyContract(
        chain,
        verificationInput,
      );
    } catch (error) {
      // log error but keep deploying, can also verify post-deployment if needed
      this.logger.debug(`Error verifying contract: ${error}`);
    }

    return contract;
  }

  /**
   * Deploys a contract with a specified name.
   *
   * This is a generic function capable of deploying any contract type, defined within the `Factories` type, to a specified chain.
   *
   * @param {ChainName} chain - The name of the chain on which the contract is to be deployed.
   * @param {K} contractKey - The key identifying the factory to use for deployment.
   * @param {string} contractName - The name of the contract to deploy. This must match the contract source code.
   * @param {Parameters<Factories[K]['deploy']>} constructorArgs - Arguments for the contract's constructor.
   * @param {Parameters<Awaited<ReturnType<Factories[K]['deploy']>>['initialize']>?} initializeArgs - Optional arguments for the contract's initialization function.
   * @param {boolean} shouldRecover - Flag indicating whether to attempt recovery if deployment fails.
   * @returns {Promise<HyperlaneContracts<Factories>[K]>} A promise that resolves to the deployed contract instance.
   */
  async deployContractWithName<K extends keyof Factories>(
    chain: ChainName,
    contractKey: K,
    contractName: string,
    constructorArgs: Parameters<Factories[K]['deploy']>,
    initializeArgs?: Parameters<
      Awaited<ReturnType<Factories[K]['deploy']>>['initialize']
    >,
    shouldRecover = true,
  ): Promise<HyperlaneContracts<Factories>[K]> {
    const contract = await this.deployContractFromFactory(
      chain,
      this.factories[contractKey],
      contractName,
      constructorArgs,
      initializeArgs,
      shouldRecover,
    );
    this.writeCache(chain, contractName, contract.address);
    return contract;
  }

  async deployContract<K extends keyof Factories>(
    chain: ChainName,
    contractKey: K,
    constructorArgs: Parameters<Factories[K]['deploy']>,
    initializeArgs?: Parameters<
      Awaited<ReturnType<Factories[K]['deploy']>>['initialize']
    >,
    shouldRecover = true,
  ): Promise<HyperlaneContracts<Factories>[K]> {
    return this.deployContractWithName(
      chain,
      contractKey,
      contractKey.toString(),
      constructorArgs,
      initializeArgs,
      shouldRecover,
    );
  }

  protected async changeAdmin(
    chain: ChainName,
    proxy: ITransparentUpgradeableProxy,
    admin: string,
  ): Promise<void> {
    const actualAdmin = await proxyAdmin(
      this.multiProvider.getProvider(chain),
      proxy.address,
    );
    if (eqAddress(admin, actualAdmin)) {
      this.logger.debug(`Admin set correctly, skipping admin change`);
      return;
    }

    const txOverrides = this.multiProvider.getTransactionOverrides(chain);
    this.logger.debug(`Changing proxy admin`);
    await this.runIfAdmin(
      chain,
      proxy,
      () =>
        this.multiProvider.handleTx(
          chain,
          proxy.changeAdmin(admin, txOverrides),
        ),
      (proxyAdmin: ProxyAdmin) =>
        this.multiProvider.handleTx(
          chain,
          proxyAdmin.changeProxyAdmin(proxy.address, admin, txOverrides),
        ),
    );
  }

  protected async upgradeAndInitialize<C extends ethers.Contract>(
    chain: ChainName,
    proxy: ITransparentUpgradeableProxy,
    implementation: C,
    initializeArgs: Parameters<C['initialize']>,
  ): Promise<void> {
    const current = await proxy.callStatic.implementation();
    if (eqAddress(implementation.address, current)) {
      this.logger.debug(`Implementation set correctly, skipping upgrade`);
      return;
    }

    this.logger.debug(`Upgrading and initializing implementation`);
    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initializeArgs,
    );
    const overrides = this.multiProvider.getTransactionOverrides(chain);
    await this.runIfAdmin(
      chain,
      proxy,
      () =>
        this.multiProvider.handleTx(
          chain,
          proxy.upgradeToAndCall(implementation.address, initData, overrides),
        ),
      (proxyAdmin: ProxyAdmin) =>
        this.multiProvider.handleTx(
          chain,
          proxyAdmin.upgradeAndCall(
            proxy.address,
            implementation.address,
            initData,
            overrides,
          ),
        ),
    );
  }

  protected async deployProxy<C extends ethers.Contract>(
    chain: ChainName,
    implementation: C,
    proxyAdmin: string,
    initializeArgs?: Parameters<C['initialize']>,
  ): Promise<C> {
    const isProxied = await isProxy(
      this.multiProvider.getProvider(chain),
      implementation.address,
    );
    if (isProxied) {
      // if the implementation is already a proxy, do not deploy a new proxy
      return implementation;
    }

    const constructorArgs = proxyConstructorArgs(
      implementation,
      proxyAdmin,
      initializeArgs,
    );
    const proxy = await this.deployContractFromFactory(
      chain,
      new TransparentUpgradeableProxy__factory(),
      'TransparentUpgradeableProxy',
      constructorArgs,
    );

    return implementation.attach(proxy.address) as C;
  }

  async deployTimelock(
    chain: ChainName,
    timelockConfig: UpgradeConfig['timelock'],
  ): Promise<TimelockController> {
    return this.multiProvider.handleDeploy(
      chain,
      new TimelockController__factory(),
      // delay, [proposers], [executors], admin
      [
        timelockConfig.delay,
        [timelockConfig.roles.proposer],
        [timelockConfig.roles.executor],
        ethers.constants.AddressZero,
      ],
    );
  }

  writeCache<K extends keyof Factories>(
    chain: ChainName,
    contractName: K,
    address: Address,
  ): void {
    if (!this.cachedAddresses[chain]) {
      this.cachedAddresses[chain] = {};
    }
    this.cachedAddresses[chain][contractName] = address;
  }

  readCache<F extends ethers.ContractFactory>(
    chain: ChainName,
    factory: F,
    contractName: string,
  ): Awaited<ReturnType<F['deploy']>> | undefined {
    const cachedAddress = this.cachedAddresses[chain]?.[contractName];
    const hit =
      !!cachedAddress && cachedAddress !== ethers.constants.AddressZero;
    const contractAddress = hit ? cachedAddress : ethers.constants.AddressZero;
    const contract = factory
      .attach(contractAddress)
      .connect(this.multiProvider.getSignerOrProvider(chain)) as Awaited<
      ReturnType<F['deploy']>
    >;
    if (hit) {
      this.logger.debug(
        `Recovered ${contractName.toString()} on ${chain} ${cachedAddress}`,
      );
      return contract;
    }
    return undefined;
  }

  async recoverVerificationArtifacts<C extends ethers.Contract>(
    chain: ChainName,
    contractName: string,
    cachedContract: C,
    constructorArgs: Parameters<C['deploy']>,
    initializeArgs?: Parameters<C['initialize']>,
  ): Promise<ContractVerificationInput[]> {
    const provider = this.multiProvider.getProvider(chain);
    const isProxied = await isProxy(provider, cachedContract.address);

    let implementation: string;
    if (isProxied) {
      implementation = await proxyImplementation(
        provider,
        cachedContract.address,
      );
    } else {
      implementation = cachedContract.address;
    }

    const implementationInput = buildVerificationInput(
      contractName,
      implementation,
      cachedContract.interface.encodeDeploy(constructorArgs),
    );

    if (!isProxied) {
      return [implementationInput];
    }

    const admin = await proxyAdmin(provider, cachedContract.address);
    const proxyArgs = proxyConstructorArgs(
      cachedContract.attach(implementation),
      admin,
      initializeArgs,
    );
    const proxyInput = buildVerificationInput(
      'TransparentUpgradeableProxy',
      cachedContract.address,
      TransparentUpgradeableProxy__factory.createInterface().encodeDeploy(
        proxyArgs,
      ),
    );
    return [implementationInput, proxyInput];
  }

  /**
   * Deploys the Implementation and Proxy for a given contract
   *
   */
  async deployProxiedContract<K extends keyof Factories>(
    chain: ChainName,
    contractKey: K,
    contractName: string,
    proxyAdmin: string,
    constructorArgs: Parameters<Factories[K]['deploy']>,
    initializeArgs?: Parameters<HyperlaneContracts<Factories>[K]['initialize']>,
  ): Promise<HyperlaneContracts<Factories>[K]> {
    // Try to initialize the implementation even though it may not be necessary
    const implementation = await this.deployContractWithName(
      chain,
      contractKey,
      contractName,
      constructorArgs,
      initializeArgs,
    );

    // Initialize the proxy the same way
    const contract = await this.deployProxy(
      chain,
      implementation,
      proxyAdmin,
      initializeArgs,
    );
    this.writeCache(chain, contractName, contract.address);
    return contract;
  }

  mergeWithExistingVerificationInputs(
    existingInputsMap: ChainMap<ContractVerificationInput[]>,
  ): ChainMap<ContractVerificationInput[]> {
    const allChains = new Set<ChainName>();
    Object.keys(existingInputsMap).forEach((_) => allChains.add(_));
    Object.keys(this.verificationInputs).forEach((_) => allChains.add(_));

    const ret: ChainMap<ContractVerificationInput[]> = {};
    for (const chain of allChains) {
      const existingInputs = existingInputsMap[chain] || [];
      const newInputs = this.verificationInputs[chain] || [];
      ret[chain] = [...existingInputs, ...newInputs];
    }
    return ret;
  }

  async transferOwnershipOfContracts<K extends keyof Factories>(
    chain: ChainName,
    config: OwnableConfig<K>,
    ownables: Partial<Record<K, Ownable>>,
  ): Promise<ethers.ContractReceipt[]> {
    const receipts: ethers.ContractReceipt[] = [];
    for (const [contractName, ownable] of Object.entries<Ownable | undefined>(
      ownables,
    )) {
      if (!ownable) {
        continue;
      }
      const current = await ownable.owner();
      const owner = config.ownerOverrides?.[contractName as K] ?? config.owner;
      if (!eqAddress(current, owner)) {
        this.logger.debug('Current owner and config owner to not match');
        const receipt = await this.runIfOwner(chain, ownable, () => {
          this.logger.debug(
            `Transferring ownership of ${contractName} to ${owner} on ${chain}`,
          );
          return this.multiProvider.handleTx(
            chain,
            ownable.transferOwnership(
              owner,
              this.multiProvider.getTransactionOverrides(chain),
            ),
          );
        });
        if (receipt) receipts.push(receipt);
      }
    }

    return receipts.filter((x) => !!x) as ethers.ContractReceipt[];
  }
}
