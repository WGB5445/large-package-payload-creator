# large-package-payload-creator

A CLI tool for splitting large Aptos Move contract packages into multiple JSON payloads for multi-signature or object deployment. Supports batch upload, upgrade mode, and custom network/RPC. Ideal for developers deploying large Move packages on Aptos.

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

### Options

- `-d, --dir <directory>`: Project directory (default: current directory)
- `--deploy-object <boolean>`: Use object deployment (true/false, required)
- `--multi-sign <boolean>`: Use multi-signature deployment (true/false, required)
- `--large-package <boolean>`: Use large package deployment (true/false, required)
- `--sender-address <address>`: Sender address (required if used)
- `--contract-name <string>`: Contract address name (required if used)
- `--rpc <url>`: Custom RPC endpoint URL
- `--network <network>`: Network to use (`mainnet`, `testnet`, `devnet`, default: `devnet`)
- `--large-package-address <address>`: Address of the large package contract (default: `0x7`)
- `--upgrade <boolean>`: Upgrade operation (true/false, default: false)
- `--object-address <address>`: Object address for upgrade (required if `--upgrade` is true)

## Example

```bash
large-package-payload-creator create \
  --dir ./my-move-project \
  --deploy-object true \
  --multi-sign true \
  --large-package true \
  --sender-address 0xYourAddress \
  --contract-address-name contract \
  --network devnet
```

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
