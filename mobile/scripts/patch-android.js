'use strict';
// After `cap add/sync android`: camera permission for QR pairing. Cleartext
// HTTP (for the PC on your Wi-Fi) comes from capacitor.config.json.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(file)) { console.log('no android project yet'); process.exit(0); }
let xml = fs.readFileSync(file, 'utf8');
let changed = false;
if (!xml.includes('android.permission.CAMERA')) {
  xml = xml.replace('<application', '<uses-permission android:name="android.permission.CAMERA" />\n    <application');
  changed = true;
}
// The PC companion is plain HTTP on your own network (messages are sealed end to end).
if (!xml.includes('usesCleartextTraffic')) {
  xml = xml.replace('<application', '<application android:usesCleartextTraffic="true"');
  changed = true;
}
if (changed) { fs.writeFileSync(file, xml); console.log('patched AndroidManifest.xml'); }

// 13.0: a tiny native plugin so approving a desktop action from the phone needs the owner's
// fingerprint, face or screen lock (androidx.biometric). Declining or stopping never needs it.
const appId = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capacitor.config.json'), 'utf8')).appId;
const javaDir = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', ...appId.split('.'));
fs.mkdirSync(javaDir, { recursive: true });
fs.writeFileSync(path.join(javaDir, 'BiometricConfirmPlugin.java'), `package ${appId};

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BiometricConfirm")
public class BiometricConfirmPlugin extends Plugin {
  private static final int AUTH = BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

  @PluginMethod
  public void available(PluginCall call) {
    JSObject o = new JSObject();
    o.put("available", BiometricManager.from(getContext()).canAuthenticate(AUTH) == BiometricManager.BIOMETRIC_SUCCESS);
    call.resolve(o);
  }

  @PluginMethod
  public void confirm(PluginCall call) {
    String title = call.getString("title", "Confirm");
    String subtitle = call.getString("subtitle", "");
    getActivity().runOnUiThread(() -> {
      BiometricPrompt prompt = new BiometricPrompt((FragmentActivity) getActivity(), ContextCompat.getMainExecutor(getContext()), new BiometricPrompt.AuthenticationCallback() {
        @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) { JSObject o = new JSObject(); o.put("ok", true); call.resolve(o); }
        @Override public void onAuthenticationError(int code, CharSequence message) { JSObject o = new JSObject(); o.put("ok", false); o.put("error", String.valueOf(message)); call.resolve(o); }
      });
      prompt.authenticate(new BiometricPrompt.PromptInfo.Builder().setTitle(title).setSubtitle(subtitle).setAllowedAuthenticators(AUTH).build());
    });
  }
}
`);
const main = path.join(javaDir, 'MainActivity.java');
if (fs.existsSync(main)) {
  let src = fs.readFileSync(main, 'utf8');
  if (!src.includes('BiometricConfirmPlugin')) {
    src = src.replace(/public class MainActivity extends BridgeActivity \{[\s\S]*\}\s*$/, 'public class MainActivity extends BridgeActivity {\n  @Override\n  public void onCreate(android.os.Bundle savedInstanceState) {\n    registerPlugin(BiometricConfirmPlugin.class);\n    super.onCreate(savedInstanceState);\n  }\n}\n');
    fs.writeFileSync(main, src);
    console.log('registered BiometricConfirm in MainActivity');
  }
}
const gradle = path.join(__dirname, '..', 'android', 'app', 'build.gradle');
if (fs.existsSync(gradle)) {
  let g = fs.readFileSync(gradle, 'utf8');
  if (!g.includes('androidx.biometric')) {
    g = g.replace(/dependencies\s*\{/, 'dependencies {\n    implementation "androidx.biometric:biometric:1.1.0"');
    fs.writeFileSync(gradle, g);
    console.log('added androidx.biometric');
  }
}
