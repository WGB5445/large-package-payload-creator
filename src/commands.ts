import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { Command } from 'commander';
import { AccountAddress, createObjectAddress, Serializer } from '@aptos-labs/ts-sdk';

// Check if Move.toml exists in the specified directory
function isMoveProject(dir: string = process.cwd()): boolean {
  return fs.existsSync(path.join(dir, 'Move.toml'));
}

// Check if the aptos command exists in the system
function checkAptosCliExists() {
  try {
    execSync('aptos --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Build result interface
interface BuildResult {
  metadataChunk: Buffer;
  codeChunks: Buffer[];
  packageName: string;
  moduleNames: string[];
}

// Payload interface
interface Payload {
  function_id: string;
  type_args: any[];
  args: Array<{
    type: string;
    value: string | number[] | string[];
  }>;
}

// Build config interface
interface BuildConfig {
  projectDir: string;
  contractAddressName?: string;
  senderAddress?: string;
  namedAddresses?: string;
additionalArgs?: string; 
}

// Parse Move.toml to get the package name
function getPackageName(projectDir: string): string {
  const moveTomlPath = path.join(projectDir, 'Move.toml');
  if (!fs.existsSync(moveTomlPath)) {
    throw new Error('Move.toml not found');
  }
  
  const moveTomlContent = fs.readFileSync(moveTomlPath, 'utf-8');
  const nameMatch = moveTomlContent.match(/\[package\][^\[]*name\s*=\s*"([^"]+)"/s);
  if (!nameMatch || !nameMatch[1]) {
    throw new Error('Package name not found in Move.toml');
  }
  return nameMatch[1];
}

// Build command arguments for named addresses
function buildNamedAddressesArg(config: BuildConfig): string {
  if (config.namedAddresses) {
    return `--named-addresses ${config.namedAddresses}`;
  }
  if (config.contractAddressName && config.senderAddress) {
    return `--named-addresses ${config.contractAddressName}=${config.senderAddress}`;
  }
  return '';
}

// Parse build output to get module names
function parseModuleNames(buildOutput: string): string[] {
  const jsonMatch = buildOutput.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return [];
  }
  
  try {
    const buildJson = JSON.parse(jsonMatch[0]);
    if (Array.isArray(buildJson.Result)) {
      return buildJson.Result.map((item: any) => {
        const match = item.match(/::(\w+)$/);
        return match ? match[1] : null;
      }).filter(Boolean);
    }
  } catch (err) {
    console.warn('Failed to parse build output JSON:', err);
  }
  
  return [];
}

// Read metadata and bytecode
function readBuildArtifacts(projectDir: string, packageName: string, moduleNames: string[]): { metadataChunk: Buffer; codeChunks: Buffer[] } {
  // Read metadata
  const metadataPath = path.join(projectDir, 'build', packageName, 'package-metadata.bcs');
  if (!fs.existsSync(metadataPath)) {
    throw new Error('package-metadata.bcs not found');
  }
  const metadataChunk = Buffer.from(fs.readFileSync(metadataPath));

  // Read all module bytecode
  const bytecodeDir = path.join(projectDir, 'build', packageName, 'bytecode_modules');
  const codeChunks: Buffer[] = [];
  
  for (const mod of moduleNames) {
    const modPath = path.join(bytecodeDir, `${mod}.mv`);
    if (!fs.existsSync(modPath)) {
      throw new Error(`Module file not found: ${modPath}`);
    }
    codeChunks.push(Buffer.from(fs.readFileSync(modPath)));
  }

  return { metadataChunk, codeChunks };
}

// Unified build function
function buildMoveProject(config: BuildConfig): BuildResult {
  const namedArg = buildNamedAddressesArg(config);
  const buildCommand = `aptos move build --save-metadata ${namedArg} ${config.additionalArgs? config.additionalArgs: ""}`.trim();
  
  const buildOutput = execSync(buildCommand, {
    cwd: config.projectDir,
    encoding: 'utf-8',
  });

  const packageName = getPackageName(config.projectDir);
  const moduleNames = parseModuleNames(buildOutput);
  const { metadataChunk, codeChunks } = readBuildArtifacts(config.projectDir, packageName, moduleNames);

  return {
    metadataChunk,
    codeChunks,
    packageName,
    moduleNames
  };
}

// Simulate in batches, return payloads
function simulatePayloads(metadataChunk: Buffer, codeChunks: Buffer[], maxSize: number, isObjectDeploy: boolean = false, largePackageAddress: string = "0x7", isUpgrade: boolean = false, objectAddress?: string): Payload[] {
  let idx = 0;
  let isFirst = true;
  const payloads: Payload[] = [];
  
  while (idx < codeChunks.length) {
    let curSize = 0;
    const curChunks: Buffer[] = [];
    const codeIndices: number[] = [];
    const meta = isFirst ? metadataChunk : Buffer.alloc(0);
    curSize += meta.length;
    
    for (; idx < codeChunks.length; idx++) {
      const chunk = codeChunks[idx];
      if (curSize + chunk.length > maxSize) break;
      curChunks.push(chunk);
      codeIndices.push(idx);
      curSize += chunk.length;
    }
    
    // Determine if this is the last call
    const isLastCall = idx >= codeChunks.length;
    
    let functionId = `${largePackageAddress}::large_packages::stage_code_chunk`;
    const args: Array<{
      type: string;
      value: string | number[] | string[];
    }> = [
      {
        type: "hex",
        value: "0x" + meta.toString('hex')
      },
      {
        type: "u16",
        value: codeIndices
      },
      {
        type: "hex",
        value: curChunks.map(buf => "0x" + buf.toString('hex'))
      }
    ];
    
    if (isLastCall) {
      // For the last call, select different functions based on deployment type
      if (isObjectDeploy) {
        if (isUpgrade) {
          functionId = `${largePackageAddress}::large_packages::stage_code_chunk_and_upgrade_object_code`;
          // Upgrade mode requires adding object address parameter
          if (objectAddress) {
            args.push({
              type: "address",
              value: objectAddress
            });
          }
        } else {
          functionId = `${largePackageAddress}::large_packages::stage_code_chunk_and_publish_to_object`;
        }
      } else {
        functionId = `${largePackageAddress}::large_packages::stage_code_chunk_and_publish_to_account`;
      }
    }
    
    payloads.push({
      function_id: functionId,
      type_args: [],
      args: args
    });
    
    isFirst = false;
  }
  
  return payloads;
}

// Generate payload JSON files
function writePayloads(payloads: Payload[], outDir: string): void {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  
  payloads.forEach((payload, i) => {
    const outPath = path.join(outDir, `payload_${i + 1}.json`);
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
  });
  
  console.log(`Generated ${payloads.length} payload JSON files, saved in ${outDir}`);
}

// Build and generate payloads
function buildAndGeneratePayloads(config: BuildConfig, output?: string, isObjectDeploy: boolean = false, largePackageAddress: string = "0x7", isUpgrade: boolean = false, objectAddress?: string): number {
  try {
    const buildResult = buildMoveProject(config);
    const MAX_SIZE = 60 * 1024; // 60KB
    const payloads = simulatePayloads(buildResult.metadataChunk, buildResult.codeChunks, MAX_SIZE, isObjectDeploy, largePackageAddress, isUpgrade, objectAddress);
    const outDir = output ? path.dirname(output) : config.projectDir;
    writePayloads(payloads, outDir);
    return payloads.length;
  } catch (err) {
    throw new Error(`Build and generate payloads failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function registerCreateCommand(program: Command) {
  program
    .command('create')
    .description('Create a new multi-sign payload')
    .option('-d, --dir <directory>', 'Project directory', process.cwd())
    .option('--deploy-object <boolean>', 'Whether to use object send (true/false)', false)
    .option('--large-package <boolean>', 'Whether to use large package send (true/false)', true)
    .requiredOption('--sender-address <address>', 'The sender address, required if used')
    .requiredOption('--contract-address-name <string>', 'The contract address name , required if used, e.g. "Move.tmol contract = 0x1 is <contract>"')
    .option('--rpc <url>', 'Custom RPC endpoint URL')
    .option('--network <network>', 'Network to use (mainnet, testnet, devnet)', 'devnet')
    .option('--large-package-address <address>', 'Address of the large package contract, if devent is 0x7, testnet/mainnet is 0x0e1ca3011bdd07246d4d16d909dbb2d6953a86c4735d5acf5865d962c630cce7', '0x7')
    .option('--object-address <address>', 'Object address for upgrade operations')
    .option('--multi-sign <boolean>', 'Whether to use multi-sign mode (true/false)', false)
    // Extra arguments passed to aptos-cli
    .option('--additional-args <string>', 'Additional arguments to pass to aptos-cli')
    .action((options, command) => {
      if (process.argv.slice(2).length === 1) {
        command.help();
        return;
      }

      // Validate environment and parameters
      if (!checkAptosCliExists()) {
        console.error('The "aptos" CLI is not found in your system. Please install it from https://aptos.dev/en/build/cli');
        process.exit(1);
      }
      
      const projectDir = options.dir || process.cwd();
      if (!isMoveProject(projectDir)) {
        console.error(`Move.toml not found. The specified directory is not a Move project folder: ${projectDir}`);
        process.exit(1);
      }

      if (!options.contractAddressName) {
        console.error('Error: --contract-address-name is required when using this option');
        process.exit(1);
      }

      // Validate network option
      if (options.network && !['mainnet', 'testnet', 'devnet'].includes(options.network)) {
        console.error('Error: --network must be one of: mainnet, testnet, devnet');
        process.exit(1);
      }

      if (options.objectAddress){
        options.deployObject = true;
      }

      switch (options.nextwork) {
        case 'mainnet':
        case 'testnet':
            if( options.largePackageAddress !== '0x7' ) {
                console.warn('Warning: --large-package-address is not supported on mainnet/testnet, using default 0x0e1ca3011bdd07246d4d16d909dbb2d6953a86c4735d5acf5865d962c630cce7');
                options.largePackageAddress = '0x0e1ca3011bdd07246d4d16d909dbb2d6953a86c4735d5acf5865d962c630cce7';
            }
            break;
        default:
            break;
      }

      const networkUrl = getNetworkUrl(options.network, options.rpc);
      console.log('Using network URL:', networkUrl);

      console.log('Creating payload...');
      
      try {
        const MAX_SIZE = 60 * 1024; // 60KB
        
        if (options.objectAddress || options.deployObject === true) {
          handleDeployObjectMode(projectDir, options, MAX_SIZE);
        } else {
          handleNormalMode(projectDir, options, MAX_SIZE);
        }
      } catch (e) {
        console.error('Failed to create payload:', e instanceof Error ? e.message : e);
        process.exit(1);
      }
      

    });
}

// Handle deploy object mode
async function handleDeployObjectMode(projectDir: string, options: any, maxSize: number): Promise<void> {
  // Step 1: Build once to get metadataChunk/codeChunks
  const buildConfig: BuildConfig = {
    projectDir,
    contractAddressName: options.contractAddressName,
    senderAddress: options.senderAddress,
    additionalArgs: options.additionalArgs,
  };
  
  const buildResult = buildMoveProject(buildConfig);
  
  const isUpgrade = options.objectAddress && options.objectAddress !== '';
  const payloadsSim = simulatePayloads(buildResult.metadataChunk, buildResult.codeChunks, maxSize, true, options.largePackageAddress, isUpgrade, options.objectAddress);
  console.log(`Simulated ${payloadsSim.length + 1} payloads`);
  let finalAddress: string;
  
  if (isUpgrade) {
    // Upgrade mode: use the provided object address
    finalAddress = options.objectAddress;
    console.log('Upgrade mode, using object address:', finalAddress);
  } else {
    // Create mode: calculate new object address
    const result = await fetch(`${getNetworkUrl(options.network, options.rpc)}/accounts/${options.senderAddress}/resource/0x1::account::Account`)
    let sequences = 0;

    const accountData = await result.json();
    if (accountData.type === '0x1::account::Account' && accountData.data && accountData.data.sequence_number) {
        sequences = parseInt(accountData.data.sequence_number, 10);
    }

    const ser = new Serializer();
    ser.serializeBytes(Buffer.from("aptos_framework::object_code_deployment", 'utf-8'));
    if(options.multiSign === 'true') {
        ser.serializeU64(sequences + 1);
    }else{
        ser.serializeU64(sequences + payloadsSim.length);
    }
    const seed = ser.toUint8Array();
    finalAddress = createObjectAddress(
        AccountAddress.fromString(options.senderAddress),
        seed
    ).toString();
    console.log('Create mode, calculated new address:', finalAddress);
  }

  const newBuildConfig: BuildConfig = {
    projectDir,
    contractAddressName: options.contractAddressName,
    senderAddress: finalAddress,
    additionalArgs: options.additionalArgs,
  };
  
  const count = buildAndGeneratePayloads(newBuildConfig, options.output, true, options.largePackageAddress, isUpgrade, isUpgrade ? options.objectAddress : undefined);
  
}

// Handle normal mode
function handleNormalMode(projectDir: string, options: any, maxSize: number): void {
  const buildConfig: BuildConfig = {
    projectDir,
    contractAddressName: options.contractAddressName,
    senderAddress: options.senderAddress,
    additionalArgs: options.additionalArgs,
  };
  
  const buildResult = buildMoveProject(buildConfig);
  const payloads = simulatePayloads(buildResult.metadataChunk, buildResult.codeChunks, maxSize, false, options.largePackageAddress, false);
  const outDir = options.output ? path.dirname(options.output) : projectDir;
  writePayloads(payloads, outDir);
}

// Network configuration mapping
const NETWORK_URLS = {
  mainnet: 'https://fullnode.mainnet.aptoslabs.com/v1',
  testnet: 'https://fullnode.testnet.aptoslabs.com/v1',
  devnet: 'https://fullnode.devnet.aptoslabs.com/v1'
} as const;

type NetworkType = keyof typeof NETWORK_URLS;

// Get network URL
function getNetworkUrl(network?: string, rpc?: string): string {
  if (rpc) {
    return rpc;
  }
  
  if (network && network in NETWORK_URLS) {
    return NETWORK_URLS[network as NetworkType];
  }
  
  return NETWORK_URLS.devnet; // Default to devnet
}
