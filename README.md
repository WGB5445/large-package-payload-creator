# large-package-payload-creator

A powerful CLI tool for generating JSON payloads from large Aptos Move contract packages. It helps developers deploy large contracts by supporting multi-signature, manual transaction submission, and other custom workflows. The tool offers flexible options for various deployment scenarios, making it easy to handle large contract deployments on Aptos.

一个强大的命令行工具，专为大型 Aptos Move 合约服务。它可以为大型合约生成 JSON payload，方便开发者进行多签、手动发包或其他自定义操作。工具支持多种灵活参数，助力开发者高效处理 Aptos 上的大型合约部署。

## Installation

```bash
npx large-package-payload-creator

or

pnpx large-package-payload-creator
```

## Usage

```bash
large-package-payload-creator create [options]
```

### Options | 选项（中英对照）

- `-d, --dir <directory>`: Project directory (default: current directory) | Move 项目目录（默认：当前目录）
- `--deploy-object <boolean>`: Use object deployment (true/false, default: false) | 是否使用对象部署（true/false，默认：false）
- `--large-package <boolean>`: Use large package deployment (true/false, default: true) | 是否使用大包部署（true/false，默认：true）
- `--multi-sign <boolean>`: Use multi-signature deployment (true/false, default: false) | 是否多签模式（true/false，默认：false）
- `--sender-address <address>`: Sender address (required) | 发送者地址（必填）
- `--contract-address-name <string>`: Contract address name (required, e.g. MyContract=0x1...) | 合约地址名（必填，格式如：MyContract=0x1...）
- `--rpc <url>`: Custom RPC endpoint URL | 自定义 RPC 节点 URL
- `--network <network>`: Network to use (mainnet, testnet, devnet, default: devnet) | 网络类型（mainnet, testnet, devnet，默认：devnet）
- `--large-package-address <address>`: Address of the large package contract (devnet default 0x7, testnet/mainnet default 0x0e1ca3...cce7) | 大包合约地址（devnet 默认 0x7，testnet/mainnet 默认 0x0e1ca3...cce7）
- `--object-address <address>`: Object address for upgrade operations | 对象地址（升级操作时必填）
- `--additional-args <string>`: Additional arguments to pass to aptos-cli | 传递给 aptos-cli 的额外参数
- `--output-format <string>`: Output format: `json` or `default` (default: `default`). If set to `json`, only a final JSON result will be printed, and all intermediate logs and build output will be suppressed. | 输出格式：`json` 或 `default`（默认：`default`）。为 `json` 时只输出最终 JSON 结果，所有中间日志和编译输出均被抑制

## Example

```bash
pnpx large-package-payload-creator create \
  -d "your-move-project-path" \
  --multi-sign true \
  --sender-address 0xYourAddress \
  --contract-address-name YourContractName \
  --object-address 0xYourObjectAddress \
  --additional-args "--included-artifacts none --skip-fetch-latest-git-deps" \
  --network mainnet \
  --large-package-address 0xYourLargePackageAddress
```

> 说明：
> - `your-move-project-path` 替换为你的 Move 项目路径
> - `0xYourAddress` 替换为你的钱包地址
> - `YourContractName` 替换为你的合约名称
> - `0xYourObjectAddress` 替换为对象地址
> - `0xYourLargePackageAddress` 替换为大包合约地址
> - 其他参数根据实际需求调整

## Results

The tool generates a `payloads.json` file in the specified directory containing the split payloads for deployment. Each payload is structured to be compatible with the Aptos CLI for batch processing.

```
payload_1.json
payload_2.json
...
```

payload_1.json
```json
{
  "function_id": "0x7::large_packages::stage_code_chunk",
  "type_args": [],
  "args": [
    {
      "type": "hex",
      "value": "0xXXXXXXX"
    },
    {
      "type": "u16",
      "value": [
        0,
        1,
        2,
        3
      ]
    },
    {
      "type": "hex",
      "value": [
        "0xXXXXX",
        "0xXXXXX",
        "0xXXXXX",
        "0xXXXXX"
      ]
    }
  ]
}
```

payload_2.json
```json
{
  "function_id": "0x7::large_packages::stage_code_chunk_and_publish_to_object",
  "type_args": [],
  "args": [
    {
      "type": "hex",
      "value": "0x"
    },
    {
      "type": "u16",
      "value": [
        4,
        5,
        6,
        7,
        8,
        9,
        10
      ]
    },
    {
      "type": "hex",
      "value": [
        "0xXXXXX",
        "0xXXXXX",
        "0xXXXXX",
        "0xXXXXX",
        "0xXXXXX",
        "0xXXXXX",
        "0xXXXXX"
      ]
    }
  ]
}
```
## Requirements

- Node.js >= 18
- [Aptos CLI](https://aptos.dev/en/build/cli) must be installed and available in your PATH.
