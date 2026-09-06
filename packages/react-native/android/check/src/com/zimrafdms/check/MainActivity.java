package com.zimrafdms.check;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

/**
 * Emulator check for the zimra-fdms Android adapter. Starts a bridge on
 * port 9999 that exposes the keystore and an mTLS HTTP client, so the real
 * TypeScript core on the host can drive a fiscal day with this device
 * doing every signature and the TLS handshake. No React Native involved;
 * this exercises exactly the code the RN module wraps.
 */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView v = new TextView(this);
        v.setText("zimra-fdms keystore bridge on :9999");
        setContentView(v);
        new Thread(new Bridge(9999), "zimra-bridge").start();
    }
}
