# TouchDesigner Web Server DAT Callbacks
#
# Setup:
# 1. Create a Web Server DAT - set port to 9000
# 2. Create a Constant CHOP named "constant_eeg" with 25 channels
# 3. Set the Web Server DAT's callbacks parameter to this script

import json

def onWebSocketOpen(dat, client, uri):
    """Called when a WebSocket connection is opened"""
    print(f"Chords-Web connected: {client}")
    return True

def onWebSocketClose(dat, client):
    """Called when a WebSocket connection is closed"""
    print(f"Chords-Web disconnected: {client}")

def onWebSocketReceiveText(dat, client, data):
    """Called when a text message is received from the WebSocket"""
    try:
        msg = json.loads(data)

        # Get the constant CHOP to output values
        chop_out = op('constant_eeg')
        if not chop_out:
            return

        # Timestamp
        chop_out.par.value0 = msg.get('ts', 0)

        # Device 1 filtered channels
        chop_out.par.value1 = msg.get('d1_ch0', 0)
        chop_out.par.value2 = msg.get('d1_ch1', 0)
        chop_out.par.value3 = msg.get('d1_ch2', 0)

        # Device 2 filtered channels
        chop_out.par.value4 = msg.get('d2_ch0', 0)
        chop_out.par.value5 = msg.get('d2_ch1', 0)
        chop_out.par.value6 = msg.get('d2_ch2', 0)

        # Device 1 alpha
        chop_out.par.value7 = msg.get('d1_ch0_alpha', 0)
        chop_out.par.value8 = msg.get('d1_ch1_alpha', 0)
        chop_out.par.value9 = msg.get('d1_ch2_alpha', 0)

        # Device 1 theta
        chop_out.par.value10 = msg.get('d1_ch0_theta', 0)
        chop_out.par.value11 = msg.get('d1_ch1_theta', 0)
        chop_out.par.value12 = msg.get('d1_ch2_theta', 0)

        # Device 1 delta
        chop_out.par.value13 = msg.get('d1_ch0_delta', 0)
        chop_out.par.value14 = msg.get('d1_ch1_delta', 0)
        chop_out.par.value15 = msg.get('d1_ch2_delta', 0)

        # Device 2 alpha
        chop_out.par.value16 = msg.get('d2_ch0_alpha', 0)
        chop_out.par.value17 = msg.get('d2_ch1_alpha', 0)
        chop_out.par.value18 = msg.get('d2_ch2_alpha', 0)

        # Device 2 theta
        chop_out.par.value19 = msg.get('d2_ch0_theta', 0)
        chop_out.par.value20 = msg.get('d2_ch1_theta', 0)
        chop_out.par.value21 = msg.get('d2_ch2_theta', 0)

        # Device 2 delta
        chop_out.par.value22 = msg.get('d2_ch0_delta', 0)
        chop_out.par.value23 = msg.get('d2_ch1_delta', 0)
        chop_out.par.value24 = msg.get('d2_ch2_delta', 0)

    except json.JSONDecodeError as e:
        print(f"JSON parse error: {e}")

def onWebSocketReceiveBinary(dat, client, data):
    """Called when binary data is received"""
    pass

def onWebSocketReceivePing(dat, client, data):
    """Called when a ping is received"""
    return True

def onWebSocketReceivePong(dat, client, data):
    """Called when a pong is received"""
    pass
