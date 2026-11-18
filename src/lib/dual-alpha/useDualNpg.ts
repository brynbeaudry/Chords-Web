// Two NPG Lite headsets over Web Bluetooth (plan §5.4 P2).
// Built from connectDevice / disconnectDevice / handleDevice*Notification /
// processDeviceSample of src/app/dual-stream/page.tsx: same UUIDs, same packet decoding
// (7-byte samples: counter + 3 x big-endian int16, 10 per notification), same 1 s watchdog.
// Counter gaps are counted per device instead of logged.
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Slot } from './engine';

const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const DATA_CHAR_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
const CONTROL_CHAR_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';
const SINGLE_SAMPLE_LEN = 7;
const BLOCK_COUNT = 10;
const NEW_PACKET_LEN = SINGLE_SAMPLE_LEN * BLOCK_COUNT;

export type SampleHandler = (slot: Slot, counter: number, raw: number[]) => void;

interface DeviceState {
    connected: boolean;
    loading: boolean;
    name: string;
    gaps: number;       // counter discontinuities since connect (lost BLE samples)
}

const empty: DeviceState = { connected: false, loading: false, name: '', gaps: 0 };

/** Decode one notification into samples; exported for tests and replays of raw packets. */
export function decodePacket(value: DataView): { counter: number; raw: number[] }[] {
    const out: { counter: number; raw: number[] }[] = [];
    if (value.byteLength !== NEW_PACKET_LEN && value.byteLength !== SINGLE_SAMPLE_LEN) return out;
    for (let i = 0; i + SINGLE_SAMPLE_LEN <= value.byteLength; i += SINGLE_SAMPLE_LEN) {
        out.push({
            counter: value.getUint8(i),
            raw: [value.getInt16(i + 1, false), value.getInt16(i + 3, false), value.getInt16(i + 5, false)],
        });
    }
    return out;
}

export function useDualNpg(onSample: SampleHandler, onConnect?: (slot: Slot) => void) {
    const [devices, setDevices] = useState<Record<Slot, DeviceState>>({ 1: { ...empty }, 2: { ...empty } });
    const onSampleRef = useRef(onSample);
    const onConnectRef = useRef(onConnect);
    useEffect(() => { onSampleRef.current = onSample; onConnectRef.current = onConnect; });

    const deviceRef = useRef<Record<Slot, any>>({ 1: null, 2: null });
    const charRef = useRef<Record<Slot, any>>({ 1: null, 2: null });
    const handlerRef = useRef<Record<Slot, ((e: Event) => void) | null>>({ 1: null, 2: null });
    const prevCounter = useRef<Record<Slot, number | null>>({ 1: null, 2: null });
    const gaps = useRef<Record<Slot, number>>({ 1: 0, 2: 0 });
    const received = useRef<Record<Slot, number>>({ 1: 0, 2: 0 });
    const watchdog = useRef<Record<Slot, ReturnType<typeof setInterval> | null>>({ 1: null, 2: null });

    const patch = (slot: Slot, p: Partial<DeviceState>) =>
        setDevices((d) => ({ ...d, [slot]: { ...d[slot], ...p } }));

    const disconnect = useCallback(async (slot: Slot, reason?: string) => {
        if (watchdog.current[slot]) clearInterval(watchdog.current[slot]!);
        watchdog.current[slot] = null;
        const device = deviceRef.current[slot];
        try {
            const ch = charRef.current[slot];
            if (ch && handlerRef.current[slot]) {
                ch.removeEventListener('characteristicvaluechanged', handlerRef.current[slot]!);
                if (device?.gatt?.connected) await ch.stopNotifications();
            }
            if (device?.gatt?.connected) device.gatt.disconnect();
        } catch (e) {
            console.log(`Disconnect error for device ${slot}:`, e);
        }
        deviceRef.current[slot] = null;
        charRef.current[slot] = null;
        handlerRef.current[slot] = null;
        patch(slot, { connected: false, loading: false });
        if (reason) toast.error(reason);
        else if (device) toast.info(`Device ${slot} disconnected`);
    }, []);

    const connect = useCallback(async (slot: Slot) => {
        const nav = navigator as any;
        if (!nav.bluetooth) {
            toast.error('Web Bluetooth is not available in this browser.');
            return;
        }
        patch(slot, { loading: true });
        try {
            const device = await nav.bluetooth.requestDevice({
                filters: [{ namePrefix: 'NPG' }],
                optionalServices: [SERVICE_UUID],
            });
            const server = await device.gatt?.connect();
            if (!server) { patch(slot, { loading: false }); return; }
            const service = await server.getPrimaryService(SERVICE_UUID);
            const controlChar = await service.getCharacteristic(CONTROL_CHAR_UUID);
            const dataChar = await service.getCharacteristic(DATA_CHAR_UUID);
            await controlChar.writeValue(new TextEncoder().encode('START'));
            await dataChar.startNotifications();

            prevCounter.current[slot] = null;
            gaps.current[slot] = 0;
            received.current[slot] = 0;
            onConnectRef.current?.(slot);
            const handler = (event: Event) => {
                const value = (event.target as any).value as DataView | undefined;
                if (!value) return;
                for (const s of decodePacket(value)) {
                    const prev = prevCounter.current[slot];
                    if (prev !== null && s.counter !== (prev + 1) % 256) gaps.current[slot]++;
                    prevCounter.current[slot] = s.counter;
                    received.current[slot]++;
                    onSampleRef.current(slot, s.counter, s.raw);
                }
            };
            dataChar.addEventListener('characteristicvaluechanged', handler);
            device.addEventListener?.('gattserverdisconnected', () => {
                if (deviceRef.current[slot] === device) disconnect(slot, `Device ${slot} lost its Bluetooth connection`);
            });
            deviceRef.current[slot] = device;
            charRef.current[slot] = dataChar;
            handlerRef.current[slot] = handler;
            patch(slot, { connected: true, loading: false, name: device.name || 'NPG', gaps: 0 });
            toast.success(`Device ${slot} connected: ${device.name || 'NPG'}`);

            // Watchdog: disconnect if no samples for 1 s; also publishes the gap count.
            if (watchdog.current[slot]) clearInterval(watchdog.current[slot]!);
            watchdog.current[slot] = setInterval(() => {
                if (received.current[slot] === 0) {
                    disconnect(slot, `Device ${slot} stopped sending data — disconnected`);
                    return;
                }
                received.current[slot] = 0;
                patch(slot, { gaps: gaps.current[slot] });
            }, 1000);
        } catch (error) {
            console.log('Bluetooth error: ' + (error instanceof Error ? error.message : error));
            patch(slot, { loading: false });
        }
    }, [disconnect]);

    useEffect(() => () => {
        ([1, 2] as Slot[]).forEach((s) => {
            if (watchdog.current[s]) clearInterval(watchdog.current[s]!);
            try { deviceRef.current[s]?.gatt?.disconnect(); } catch { /* noop */ }
        });
    }, []);

    return { devices, connect, disconnect };
}
