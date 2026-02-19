#!/usr/bin/env python3
"""
Patch NPG-Lite BLE firmware binary to insert a device number into the BLE name.

Usage:
    python3 patch-firmware-name.py <input.bin> <number> [output.bin]

Examples:
    python3 patch-firmware-name.py NPG-LITE-BLE.ino.bin 1
    → Creates NPG-LITE-BLE-1.ino.bin
    → Device advertises as "NPG-Li-1-3CH:A3:F1" instead of "NPG-Lite-3CH:A3:F1"

    python3 patch-firmware-name.py NPG-LITE-BLE.ino.bin 2 my-device.bin
    → Creates my-device.bin

Naming:
    Original             → Patched (device 1)
    NPG-LITE             → NPG-LI-1E
    NPG-Lite-6CH:A3:F1   → NPG-Li-1-6CH:A3:F1
    NPG-Lite-3CH:A3:F1   → NPG-Li-1-3CH:A3:F1

    The number replaces "te" with "-N" in the BLE advertised names,
    keeping the total byte count identical (1 padding byte consumed).
"""

import sys
import os


def patch_firmware(input_path: str, number: str, output_path: str) -> None:
    with open(input_path, "rb") as f:
        data = bytearray(f.read())

    if len(number) != 1 or not number.isdigit():
        print(f"Error: number must be a single digit (0-9), got '{number}'")
        sys.exit(1)

    # The three name strings in the firmware binary and their byte layout:
    #
    # 0x148: "NPG-LITE\0"                  + 3 padding bytes → room for +3 chars
    # 0x17C: "NPG-Lite-6CH:%02X:%02X\0"    + 1 padding byte  → room for +1 char
    # 0x194: "NPG-Lite-3CH:%02X:%02X\0"    + 1 padding byte  → room for +1 char
    #
    # Strategy: "NPG-Lite" (8 chars) → "NPG-Li-N" (8 chars, same length)
    # but we insert a hyphen before the next segment, consuming the padding byte:
    #   "NPG-Lite-3CH:..."  (22 chars) → "NPG-Li-N-3CH:..." (23 chars, +1 = uses padding)

    patches = [
        # (search_bytes, replacement_bytes, description)
        (
            b"NPG-LITE\x00",
            f"NPG-LI-{number}E\x00".encode(),
            f"NPG-LITE → NPG-LI-{number}E",
        ),
        (
            b"NPG-Lite-6CH:%02X:%02X\x00",
            f"NPG-Li-{number}-6CH:%02X:%02X\x00".encode(),
            f"NPG-Lite-6CH:XX:XX → NPG-Li-{number}-6CH:XX:XX",
        ),
        (
            b"NPG-Lite-3CH:%02X:%02X\x00",
            f"NPG-Li-{number}-3CH:%02X:%02X\x00".encode(),
            f"NPG-Lite-3CH:XX:XX → NPG-Li-{number}-3CH:XX:XX",
        ),
    ]

    patched_count = 0
    for search, replace, desc in patches:
        idx = data.find(search)
        if idx == -1:
            print(f"  Warning: not found in binary, skipping: {desc}")
            continue

        # Verify we have a padding byte to consume
        end = idx + len(search)
        if end >= len(data) or data[end] != 0x00:
            print(f"  Warning: no padding byte after string at offset 0x{idx:06x}, skipping")
            continue

        # Replace in-place (consumes the padding byte for the extra char)
        data[idx : idx + len(replace)] = replace
        print(f"  Patched: {desc}  (offset 0x{idx:06x})")
        patched_count += 1

    if patched_count == 0:
        print("\nError: no strings were patched. Is this the correct firmware file?")
        sys.exit(1)

    with open(output_path, "wb") as f:
        f.write(data)

    size_kb = len(data) / 1024
    print(f"\nWritten: {output_path} ({size_kb:.1f} KB)")


def main() -> None:
    if len(sys.argv) < 3:
        print("Usage: python3 patch-firmware-name.py <input.bin> <number> [output.bin]")
        print()
        print("  input.bin  Path to NPG-LITE-BLE.ino.bin firmware file")
        print("  number     Single digit 0-9 to identify this device")
        print("  output.bin Optional output path (default: <input>-<number>.bin)")
        sys.exit(1)

    input_path = sys.argv[1]
    number = sys.argv[2]

    if len(sys.argv) >= 4:
        output_path = sys.argv[3]
    else:
        base, ext = os.path.splitext(input_path)
        output_path = f"{base}-{number}{ext}"

    if not os.path.exists(input_path):
        print(f"Error: {input_path} not found")
        sys.exit(1)

    print(f"Patching {os.path.basename(input_path)} → device number {number}...\n")
    patch_firmware(input_path, number, output_path)


if __name__ == "__main__":
    main()
