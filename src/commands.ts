import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { Command } from 'commander';
import { AccountAddress, createObjectAddress, Serializer } from '@aptos-labs/ts-sdk';

// 检查指定目录下是否有 Move.toml 文件
function isMoveProject(dir: string = process.cwd()): boolean {
  return fs.existsSync(path.join(dir, 'Move.toml'));
}

// 检查系统中是否有 aptos 命令
function checkAptosCliExists() {
  try {
    execSync('aptos --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 构建结果接口
interface BuildResult {
  metadataChunk: Buffer;
  codeChunks: Buffer[];
  packageName: string;
  moduleNames: string[];
}

// Payload 接口
interface Payload {
  function_id: string;
  type_args: any[];
  args: Array<{
    type: string;
    value: string | number[] | string[];
  }>;
}

// 构建配置接口
interface BuildConfig {
  projectDir: string;
  contractName?: string;
  senderAddress?: string;
  namedAddresses?: string;
}

// 解析 Move.toml 获取包名
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

// 构建命令参数
function buildNamedAddressesArg(config: BuildConfig): string {
  if (config.namedAddresses) {
    return `--named-addresses ${config.namedAddresses}`;
  }
  if (config.contractName && config.senderAddress) {
    return `--named-addresses ${config.contractName}=${config.senderAddress}`;
  }
  return '';
}

// 解析构建输出获取模块名
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

// 读取元数据和字节码
function readBuildArtifacts(projectDir: string, packageName: string, moduleNames: string[]): { metadataChunk: Buffer; codeChunks: Buffer[] } {
  // 读取 metadata
  const metadataPath = path.join(projectDir, 'build', packageName, 'package-metadata.bcs');
  if (!fs.existsSync(metadataPath)) {
    throw new Error('package-metadata.bcs not found');
  }
  const metadataChunk = Buffer.from(fs.readFileSync(metadataPath));

  // 读取所有模块字节码
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

// 统一的构建函数
function buildMoveProject(config: BuildConfig): BuildResult {
  const namedArg = buildNamedAddressesArg(config);
  const buildCommand = `aptos move build --save-metadata ${namedArg}`.trim();
  
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

// 分批模拟，返回 payloads
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
    
    // 判断是否为最后一次调用
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
      // 最后一次调用时根据部署类型选择不同的函数
      if (isObjectDeploy) {
        if (isUpgrade) {
          functionId = `${largePackageAddress}::large_packages::stage_code_chunk_and_upgrade_object_code`;
          // 升级模式需要添加 object address 参数
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

// 生成 payload JSON 文件
function writePayloads(payloads: Payload[], outDir: string): void {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  
  payloads.forEach((payload, i) => {
    const outPath = path.join(outDir, `payload_${i + 1}.json`);
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
  });
  
  console.log(`已生成 ${payloads.length} 个 payload JSON 文件，保存在 ${outDir}`);
}

// 构建并生成 payloads
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
    .requiredOption('--deploy-object <boolean>', 'Whether to use object send (true/false)', false)
    .requiredOption('--multi-sign <boolean>', 'Whether to use multi-sign send (true/false)', false)
    .requiredOption('--large-package <boolean>', 'Whether to use large package send (true/false)', true)
    .requiredOption('--sender-address <address>', 'The sender address, required if used')
    .option('--contract-name <string>', 'The contract address name , required if used')
    .option('--rpc <url>', 'Custom RPC endpoint URL')
    .option('--network <network>', 'Network to use (mainnet, testnet, devnet)', 'devnet')
    .option('--large-package-address <address>', 'Address of the large package contract', '0x7')
    .option('--upgrade <boolean>', 'Whether this is an upgrade operation (true/false)', 'false')
    .option('--object-address <address>', 'Object address for upgrade operations, required when --upgrade is true')
    .action((options, command) => {
      if (process.argv.slice(2).length === 1) {
        command.help();
        return;
      }

      console.log('Input:', options.input);
      console.log('Output:', options.output);
      console.log('Deploy Object:', options.deployObject);
      console.log('Multi Sign:', options.multiSign);
      console.log('Large Package:', options.largePackage);
      console.log('Large Package Address:', options.largePackageAddress);
      console.log('Network:', options.network);
      console.log('Upgrade:', options.upgrade);
      if (options.objectAddress) {
        console.log('Object Address:', options.objectAddress);
      }
      if (options.rpc) {
        console.log('Custom RPC:', options.rpc);
      }
      if (options.multiSign === 'true') {
        console.log('Multi Sign Address:', options.multiSignAddress);
      }
      
      // 验证环境和参数
      if (!checkAptosCliExists()) {
        console.error('The "aptos" CLI is not found in your system. Please install it from https://aptos.dev/en/build/cli');
        process.exit(1);
      }
      
      const projectDir = options.dir || process.cwd();
      if (!isMoveProject(projectDir)) {
        console.error(`Move.toml not found. The specified directory is not a Move project folder: ${projectDir}`);
        process.exit(1);
      }

      if (options.deployObject === 'true' && !options.senderAddress) {
        console.error('Error: --sender-address is required when --deploy-object is true');
        process.exit(1);
      }

      if (!options.contractName) {
        console.error('Error: --contract-name is required when using this option');
        process.exit(1);
      }

      // 验证升级选项
      if (options.deployObject === 'true' && options.upgrade === 'true' && !options.objectAddress && AccountAddress.fromString(options.senderAddress).toString()) {
        console.error('Error: --object-address is required when --deploy-object is true and --upgrade is true');
        process.exit(1);
      }

      // 验证网络选项
      if (options.network && !['mainnet', 'testnet', 'devnet'].includes(options.network)) {
        console.error('Error: --network must be one of: mainnet, testnet, devnet');
        process.exit(1);
      }

      // 获取网络URL
      const networkUrl = getNetworkUrl(options.network, options.rpc);
      console.log('Using network URL:', networkUrl);

      console.log('Creating payload...');
      
      try {
        const MAX_SIZE = 60 * 1024; // 60KB
        
        if (options.deployObject === 'true') {
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

// 处理 deploy object 模式
async function handleDeployObjectMode(projectDir: string, options: any, maxSize: number): Promise<void> {
  // 第一步：先 build 一次，拿到 metadataChunk/codeChunks
  const buildConfig: BuildConfig = {
    projectDir,
    contractName: options.contractName,
    senderAddress: options.senderAddress
  };
  
  const buildResult = buildMoveProject(buildConfig);
  
  const isUpgrade = options.upgrade === 'true';
  const payloadsSim = simulatePayloads(buildResult.metadataChunk, buildResult.codeChunks, maxSize, true, options.largePackageAddress, isUpgrade, options.objectAddress);
  console.log(`deploy object 模式下，需调用 ${payloadsSim.length} 次 stage_code_chunk`);

  let finalAddress: string;
  
  if (isUpgrade) {
    // 升级模式：使用提供的 object address
    finalAddress = options.objectAddress;
    console.log('升级模式，使用 object 地址:', finalAddress);
  } else {
    // 新建模式：计算新的 object address
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
    console.log('新建模式，计算得到新地址:', finalAddress);
  }

  const newBuildConfig: BuildConfig = {
    projectDir,
    contractName: options.contractName,
    senderAddress: finalAddress
  };
  
  const count = buildAndGeneratePayloads(newBuildConfig, options.output, true, options.largePackageAddress, isUpgrade, isUpgrade ? options.objectAddress : undefined);
  console.log(`已生成 ${count} 个 payload JSON 文件`);
}

// 处理普通模式
function handleNormalMode(projectDir: string, options: any, maxSize: number): void {
  const buildConfig: BuildConfig = {
    projectDir,
    contractName: options.contractName,
    senderAddress: options.senderAddress
  };
  
  const buildResult = buildMoveProject(buildConfig);
  const payloads = simulatePayloads(buildResult.metadataChunk, buildResult.codeChunks, maxSize, false, options.largePackageAddress, false);
  const outDir = options.output ? path.dirname(options.output) : projectDir;
  writePayloads(payloads, outDir);
}

// 网络配置映射
const NETWORK_URLS = {
  mainnet: 'https://fullnode.mainnet.aptoslabs.com/v1',
  testnet: 'https://fullnode.testnet.aptoslabs.com/v1',
  devnet: 'https://fullnode.devnet.aptoslabs.com/v1'
} as const;

type NetworkType = keyof typeof NETWORK_URLS;

// 获取网络URL
function getNetworkUrl(network?: string, rpc?: string): string {
  if (rpc) {
    return rpc;
  }
  
  if (network && network in NETWORK_URLS) {
    return NETWORK_URLS[network as NetworkType];
  }
  
  return NETWORK_URLS.devnet; // 默认使用 devnet
}
