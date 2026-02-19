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
    NPG-Lite-6CH:A3:F1   → NPG-Li-1-6CH:A3:F1
    NPG-Lite-3CH:A3:F1   → NPG-Li-1-3CH:A3:F1

The script also recalculates the ESP32 image checksum and SHA256 hash
so the bootloader accepts the patched firmware.
"""

import hashlib
import struct
import sys
import os


def recalculate_esp32_checksum_and_hash(data: bytearray) -> None:
    """Recalculate the ESP32 image checksum byte and SHA256 hash in-place."""

    if data[0] != 0xE9:
        print("  Warning: not a valid ESP32 image (magic != 0xE9), skipping checksum fix")
        return

    seg_count = data[1]
    hash_appended = data[23]

    # Parse segments to find the end of segment data
    offset = 24  # after 24-byte extended header
    xor_sum = 0xEF  # initial seed per ESP-IDF spec

    for s in range(seg_count):
        if offset + 8 > len(data):
            break
        seg_len = struct.unpack_from("<I", data, offset + 4)[0]
        for i in range(offset + 8, offset + 8 + seg_len):
            xor_sum ^= data[i]
        offset += 8 + seg_len

    # Checksum byte sits at the 16-byte-aligned boundary after segments
    checksum_offset = ((offset + 16) // 16) * 16 - 1
    old_checksum = data[checksum_offset]
    data[checksum_offset] = xor_sum
    print(f"  Checksum: 0x{old_checksum:02x} → 0x{xor_sum:02x}  (offset 0x{checksum_offset:06x})")

    # If hash is appended, recalculate SHA256 over everything before the hash
    if hash_appended == 1:
        hash_offset = checksum_offset + 1
        hash_data = data[:hash_offset]
        new_hash = hashlib.sha256(hash_data).digest()
        old_hash = bytes(data[hash_offset : hash_offset + 32])
        data[hash_offset : hash_offset + 32] = new_hash
        print(f"  SHA256:   {old_hash.hex()[:16]}...")
        print(f"         → {new_hash.hex()[:16]}...  (offset 0x{hash_offset:06x})")


def patch_firmware(input_path: str, number: str, output_path: str) -> None:
    with open(input_path, "rb") as f:
        data = bytearray(f.read())

    if len(number) != 1 or not number.isdigit():
        print(f"Error: number must be a single digit (0-9), got '{number}'")
        sys.exit(1)

    # BLE advertised name format strings in the firmware binary:
    #
    # 0x17C: "NPG-Lite-6CH:%02X:%02X\0"  + 1 padding byte → room for +1 char
    # 0x194: "NPG-Lite-3CH:%02X:%02X\0"  + 1 padding byte → room for +1 char
    #
    # We only patch the BLE name format strings, not the internal "NPG-LITE"
    # service identifier (which may be used for protocol-level matching).

    patches = [
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

    # Fix the ESP32 image checksum and SHA256 hash
    print()
    recalculate_esp32_checksum_and_hash(data)

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
