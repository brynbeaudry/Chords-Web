# TouchDesigner WebSocket DAT Callbacks
#
# Setup:
# 1. Create a WebSocket Server DAT - set port to 9000
# 2. Create a Constant CHOP named "constant_eeg" with 24 channels
# 3. Paste this script into the WebSocket DAT's callbacks parameter

import json

def onReceiveText(dat, rowIndex, message, bytes, peer):
    """Called when a text message is received from the WebSocket"""
    try:
        data = json.loads(message)

        # Get the constant CHOP to output values
        chop_out = op('constant_eeg')
        if not chop_out:
            return

        # Timestamp
        chop_out.par.value0 = data.get('ts', 0)

        # Device 1 filtered channels
        chop_out.par.value1 = data.get('d1_ch0', 0)
        chop_out.par.value2 = data.get('d1_ch1', 0)
        chop_out.par.value3 = data.get('d1_ch2', 0)

        # Device 2 filtered channels
        chop_out.par.value4 = data.get('d2_ch0', 0)
        chop_out.par.value5 = data.get('d2_ch1', 0)
        chop_out.par.value6 = data.get('d2_ch2', 0)

        # Device 1 alpha
        chop_out.par.value7 = data.get('d1_ch0_alpha', 0)
        chop_out.par.value8 = data.get('d1_ch1_alpha', 0)
        chop_out.par.value9 = data.get('d1_ch2_alpha', 0)

        # Device 1 theta
        chop_out.par.value10 = data.get('d1_ch0_theta', 0)
        chop_out.par.value11 = data.get('d1_ch1_theta', 0)
        chop_out.par.value12 = data.get('d1_ch2_theta', 0)

        # Device 1 delta
        chop_out.par.value13 = data.get('d1_ch0_delta', 0)
        chop_out.par.value14 = data.get('d1_ch1_delta', 0)
        chop_out.par.value15 = data.get('d1_ch2_delta', 0)

        # Device 2 alpha
        chop_out.par.value16 = data.get('d2_ch0_alpha', 0)
        chop_out.par.value17 = data.get('d2_ch1_alpha', 0)
        chop_out.par.value18 = data.get('d2_ch2_alpha', 0)

        # Device 2 theta
        chop_out.par.value19 = data.get('d2_ch0_theta', 0)
        chop_out.par.value20 = data.get('d2_ch1_theta', 0)
        chop_out.par.value21 = data.get('d2_ch2_theta', 0)

        # Device 2 delta
        chop_out.par.value22 = data.get('d2_ch0_delta', 0)
        chop_out.par.value23 = data.get('d2_ch1_delta', 0)
        chop_out.par.value24 = data.get('d2_ch2_delta', 0)

    except json.JSONDecodeError as e:
        print(f"JSON parse error: {e}")

def onConnect(dat, peer):
    print(f"Chords-Web connected: {peer}")

def onDisconnect(dat, peer):
    print(f"Chords-Web disconnected: {peer}")
