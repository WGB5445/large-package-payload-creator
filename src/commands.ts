import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  AccountAddress,
  createObjectAddress,
  Deserializer,
  Serializer,
} from "@aptos-labs/ts-sdk";
import yargs, { Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import { PackageMetadata } from "@wgb5445/aptos-move-package-metadata";

// Check if Move.toml exists in the specified directory
function isMoveProject(dir: string = process.cwd()): boolean {
  return fs.existsSync(path.join(dir, "Move.toml"));
}

// Check if the aptos command exists in the system
function checkAptosCliExists() {
  try {
    execSync("aptos --version", { stdio: "ignore" });
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
  const moveTomlPath = path.join(projectDir, "Move.toml");
  if (!fs.existsSync(moveTomlPath)) {
    throw new Error("Move.toml not found");
  }

  const moveTomlContent = fs.readFileSync(moveTomlPath, "utf-8");
  const nameMatch = moveTomlContent.match(
    /\[package\][^\[]*name\s*=\s*"([^"]+)"/s,
  );
  if (!nameMatch || !nameMatch[1]) {
    throw new Error("Package name not found in Move.toml");
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
  return "";
}

// Read metadata and bytecode
function readBuildArtifacts(
  projectDir: string,
  packageName: string,
): { metadataChunk: Buffer; codeChunks: Buffer[]; moduleNames: string[] } {
  // Read metadata
  const metadataPath = path.join(
    projectDir,
    "build",
    packageName,
    "package-metadata.bcs",
  );
  if (!fs.existsSync(metadataPath)) {
    throw new Error("package-metadata.bcs not found");
  }
  const metadataChunk = Buffer.from(fs.readFileSync(metadataPath));

  const moduleNames = PackageMetadata.deserialize(
    new Deserializer(metadataChunk),
  ).modules.map((m) => m.name);

  // Read all module bytecode
  const bytecodeDir = path.join(
    projectDir,
    "build",
    packageName,
    "bytecode_modules",
  );
  const codeChunks: Buffer[] = [];

  for (const mod of moduleNames) {
    const modPath = path.join(bytecodeDir, `${mod}.mv`);
    if (!fs.existsSync(modPath)) {
      throw new Error(`Module file not found: ${modPath}`);
    }
    codeChunks.push(Buffer.from(fs.readFileSync(modPath)));
  }

  return { metadataChunk, codeChunks, moduleNames };
}

// Unified build function
function buildMoveProject(
  config: BuildConfig,
  outputFormat?: string,
  skipBuild?: boolean,
): BuildResult {
  if (skipBuild) {
    const packageName = getPackageName(config.projectDir);
    const { metadataChunk, codeChunks, moduleNames } = readBuildArtifacts(
      config.projectDir,
      packageName,
    );
    return { metadataChunk, codeChunks, packageName, moduleNames };
  } else {
    const namedArg = buildNamedAddressesArg(config);
    const buildCommand =
      `aptos move build --save-metadata ${namedArg} ${config.additionalArgs ? config.additionalArgs : ""} 2>&1`.trim();

    const execOptions: any = {
      cwd: config.projectDir,
      encoding: "utf-8",
    };
    let buildOutput: string = "";
    if (outputFormat === "json") {
      buildOutput = execSync(buildCommand, {
        ...execOptions,
        stdio: ["ignore", "pipe", "pipe"],
      }).toString();
    } else {
      buildOutput = execSync(buildCommand, execOptions).toString();
    }

    const packageName = getPackageName(config.projectDir);
    const { metadataChunk, codeChunks, moduleNames } = readBuildArtifacts(
      config.projectDir,
      packageName,
    );
    return {
      metadataChunk,
      codeChunks,
      packageName,
      moduleNames,
    };
  }
}

// Simulate in batches, return payloads
function simulatePayloads(
  metadataChunk: Buffer,
  codeChunks: Buffer[],
  maxSize: number,
  isObjectDeploy: boolean = false,
  largePackageAddress: string = "0x7",
  isUpgrade: boolean = false,
  objectAddress?: string,
): Payload[] {
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
        value: "0x" + meta.toString("hex"),
      },
      {
        type: "u16",
        value: codeIndices,
      },
      {
        type: "hex",
        value: curChunks.map((buf) => "0x" + buf.toString("hex")),
      },
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
              value: objectAddress,
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
      args: args,
    });

    isFirst = false;
  }

  return payloads;
}

// Generate payload JSON files
function writePayloads(
  payloads: Payload[],
  outDir: string,
  outputFormat?: string,
): void {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  payloads.forEach((payload, i) => {
    const outPath = path.join(outDir, `payload_${i + 1}.json`);
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
  });

  if (outputFormat !== "json") {
    console.log(
      `Generated ${payloads.length} payload JSON files, saved in ${outDir}`,
    );
  }
}

// Build and generate payloads
function buildAndGeneratePayloads(
  config: BuildConfig,
  output?: string,
  isObjectDeploy: boolean = false,
  largePackageAddress: string = "0x7",
  isUpgrade: boolean = false,
  objectAddress?: string,
  outputFormat?: string,
  skipBuild?: boolean,
): number {
  try {
    const buildResult = buildMoveProject(config, outputFormat, skipBuild);
    const MAX_SIZE = 60 * 1024; // 60KB
    const payloads = simulatePayloads(
      buildResult.metadataChunk,
      buildResult.codeChunks,
      MAX_SIZE,
      isObjectDeploy,
      largePackageAddress,
      isUpgrade,
      objectAddress,
    );
    const outDir = output ? path.dirname(output) : config.projectDir;
    writePayloads(payloads, outDir, outputFormat);
    return payloads.length;
  } catch (err) {
    throw new Error(
      `Build and generate payloads failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ===== Yargs CLI Entrypoint =====

yargs(hideBin(process.argv))
  .command(
    "create",
    "Create a new multi-sign payload",
    (yargs: Argv) =>
      yargs
        .option("dir", {
          alias: "d",
          type: "string",
          describe: "Project directory",
          default: process.cwd(),
        })
        .option("deploy-object", {
          type: "boolean",
          describe: "Whether to use object send",
          default: false,
        })
        .option("large-package", {
          type: "boolean",
          describe: "Whether to use large package send",
          default: true,
        })
        .option("sender-address", {
          type: "string",
          describe: "The sender address",
          demandOption: true,
        })
        .option("contract-address-name", {
          type: "string",
          describe:
            "The contract address name, e.g. if MyContract=0x1..., MyContract",
          demandOption: true,
        })
        .option("rpc", {
          type: "string",
          describe: "Custom RPC endpoint URL",
        })
        .option("network", {
          type: "string",
          describe: "Network to use (mainnet, testnet, devnet)",
          default: "devnet",
          choices: ["mainnet", "testnet", "devnet"],
        })
        .option("large-package-address", {
          type: "string",
          describe: "Address of the large package contract",
          default: "0x7",
        })
        .option("object-address", {
          type: "string",
          describe: "Object address for upgrade operations",
        })
        .option("multi-sign", {
          type: "boolean",
          describe: "Whether to use multi-sign mode",
          default: false,
        })
        .option("additional-args", {
          type: "string",
          describe: "Additional arguments to pass to aptos-cli",
        })
        .option("output-format", {
          type: "string",
          describe: "Output format: json or default",
          choices: ["json", "default"],
          default: "default",
        })
        .option("skip-build", {
          type: "boolean",
          describe:
            "Skip the 'aptos move build' step and use existing build artifacts",
          default: false,
        }),
    async (argv: any) => {
      // 参数预处理
      const projectDir = argv.dir || process.cwd();
      const outputFormat = argv.outputFormat || "default";
      function printJsonResult(result: any) {
        if (outputFormat === "json") {
          console.log(JSON.stringify(result));
        }
      }
      if (!checkAptosCliExists() && !argv.skipBuild) {
        const errMsg =
          'The "aptos" CLI is not found in your system. Please install it from https://aptos.dev/en/build/cli';
        if (outputFormat === "json") {
          printJsonResult({ status: "failure", reason: errMsg });
        } else {
          console.error(errMsg);
        }
        process.exit(1);
      }
      if (!isMoveProject(projectDir)) {
        const errMsg = `Move.toml not found. The specified directory is not a Move project folder: ${projectDir}`;
        if (outputFormat === "json") {
          printJsonResult({ status: "failure", reason: errMsg });
        } else {
          console.error(errMsg);
        }
        process.exit(1);
      }
      if (!argv.contractAddressName) {
        const errMsg = "Error: --contract-address-name is required";
        if (outputFormat === "json") {
          printJsonResult({ status: "failure", reason: errMsg });
        } else {
          console.error(errMsg);
        }
        process.exit(1);
      }
      if (argv.objectAddress) {
        argv.deployObject = true;
      }
      if (["mainnet", "testnet"].includes(argv.network)) {
        if (argv.largePackageAddress === "0x7") {
          argv.largePackageAddress =
            "0x0e1ca3011bdd07246d4d16d909dbb2d6953a86c4735d5acf5865d962c630cce7";
        }
      }
      const networkUrl = getNetworkUrl(argv.network, argv.rpc);
      if (outputFormat !== "json") {
        console.log("Using network URL:", networkUrl);
        console.log("Creating payload...");
      }
      try {
        const MAX_SIZE = 60 * 1024;
        if (argv.objectAddress || argv.deployObject === true) {
          await handleDeployObjectMode(
            projectDir,
            argv,
            MAX_SIZE,
            outputFormat,
            printJsonResult,
            argv.skipBuild,
          );
        } else {
          handleNormalMode(
            projectDir,
            argv,
            MAX_SIZE,
            outputFormat,
            printJsonResult,
            argv.skipBuild,
          );
        }
      } catch (e) {
        if (outputFormat === "json") {
          printJsonResult({
            status: "failure",
            reason: e instanceof Error ? e.message : e,
          });
        } else {
          console.error(
            "Failed to create payload:",
            e instanceof Error ? e.message : e,
          );
        }
        process.exit(1);
      }
    },
  )
  .demandCommand(1)
  .help()
  .strict()
  .parse();

// Handle deploy object mode
async function handleDeployObjectMode(
  projectDir: string,
  options: any,
  maxSize: number,
  outputFormat?: string,
  printJsonResult?: (result: any) => void,
  skipBuild?: boolean,
): Promise<void> {
  try {
    // Step 1: Build once to get metadataChunk/codeChunks
    const buildConfig: BuildConfig = {
      projectDir,
      contractAddressName: options.contractAddressName,
      senderAddress: options.senderAddress,
      additionalArgs: options.additionalArgs,
    };

    const buildResult = buildMoveProject(buildConfig, outputFormat, skipBuild);

    const isUpgrade = options.objectAddress && options.objectAddress !== "";
    const payloadsSim = simulatePayloads(
      buildResult.metadataChunk,
      buildResult.codeChunks,
      maxSize,
      true,
      options.largePackageAddress,
      isUpgrade,
      options.objectAddress,
    );
    if (outputFormat !== "json") {
      console.log(`Simulated ${payloadsSim.length} payloads`);
    }
    let finalAddress: string;

    if (isUpgrade) {
      // Upgrade mode: use the provided object address
      finalAddress = options.objectAddress;
      if (outputFormat !== "json") {
        console.log("Upgrade mode, using object address:", finalAddress);
      }
    } else {
      // Create mode: calculate new object address
      const result = await fetch(
        `${getNetworkUrl(options.network, options.rpc)}/accounts/${options.senderAddress}/resource/0x1::account::Account`,
      );
      let sequences = 0;

      const accountData = await result.json();
      if (
        accountData.type === "0x1::account::Account" &&
        accountData.data &&
        accountData.data.sequence_number
      ) {
        sequences = parseInt(accountData.data.sequence_number, 10);
      }

      const ser = new Serializer();
      ser.serializeBytes(
        Buffer.from("aptos_framework::object_code_deployment", "utf-8"),
      );
      if (options.multiSign === "true") {
        ser.serializeU64(sequences + 1);
      } else {
        ser.serializeU64(sequences + payloadsSim.length);
      }
      const seed = ser.toUint8Array();
      finalAddress = createObjectAddress(
        AccountAddress.fromString(options.senderAddress),
        seed,
      ).toString();
      if (outputFormat !== "json") {
        console.log("Create mode, calculated new address:", finalAddress);
      }
    }

    const newBuildConfig: BuildConfig = {
      projectDir,
      contractAddressName: options.contractAddressName,
      senderAddress: finalAddress,
      additionalArgs: options.additionalArgs,
    };

    const count = buildAndGeneratePayloads(
      newBuildConfig,
      options.output,
      true,
      options.largePackageAddress,
      isUpgrade,
      isUpgrade ? options.objectAddress : undefined,
      outputFormat,
      options.skipBuild,
    );
    // Find output file names
    const outDir = options.output ? path.dirname(options.output) : projectDir;
    const fileNames = Array.from(
      { length: count },
      (_, i) => `payload_${i + 1}.json`,
    );
    if (outputFormat === "json" && printJsonResult) {
      printJsonResult({ status: "success", file_names: fileNames });
    }
  } catch (err: any) {
    if (outputFormat === "json" && printJsonResult) {
      printJsonResult({
        status: "failure",
        reason: err instanceof Error ? err.message : err,
      });
    } else {
      throw err;
    }
  }
}

// Handle normal mode
function handleNormalMode(
  projectDir: string,
  options: any,
  maxSize: number,
  outputFormat?: string,
  printJsonResult?: (result: any) => void,
  skipBuild?: boolean,
): void {
  try {
    const buildConfig: BuildConfig = {
      projectDir,
      contractAddressName: options.contractAddressName,
      senderAddress: options.senderAddress,
      additionalArgs: options.additionalArgs,
    };

    const buildResult = buildMoveProject(buildConfig, outputFormat, skipBuild);
    const payloads = simulatePayloads(
      buildResult.metadataChunk,
      buildResult.codeChunks,
      maxSize,
      false,
      options.largePackageAddress,
      false,
    );
    const outDir = options.output ? path.dirname(options.output) : projectDir;
    writePayloads(payloads, outDir, outputFormat);
    const fileNames = Array.from(
      { length: payloads.length },
      (_, i) => `payload_${i + 1}.json`,
    );
    if (outputFormat === "json" && printJsonResult) {
      printJsonResult({ status: "success", file_names: fileNames });
    }
  } catch (err: any) {
    if (outputFormat === "json" && printJsonResult) {
      printJsonResult({
        status: "failure",
        reason: err instanceof Error ? err.message : err,
      });
    } else {
      throw err;
    }
  }
}

// Network configuration mapping

// Get network URL
function getNetworkUrl(
  network?: "mainnet" | "testnet" | "devnet",
  rpc?: string,
): string {
  if (rpc) {
    return rpc;
  }
  const NETWORK_URLS = {
    mainnet: "https://fullnode.mainnet.aptoslabs.com/v1",
    testnet: "https://fullnode.testnet.aptoslabs.com/v1",
    devnet: "https://fullnode.devnet.aptoslabs.com/v1",
  };
  if (network && NETWORK_URLS[network]) {
    return NETWORK_URLS[network];
  }
  return NETWORK_URLS.devnet; // Default to devnet
}
