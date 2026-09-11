'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let electronApp = null;
let electronSafeStorage = null;
try {
  const electronModule = require('electron');
  electronApp = electronModule.app || null;
  electronSafeStorage = electronModule.safeStorage || null;
} catch (error) {
  console.log('[Translator] Running without Electron app context:', error.message);
}

// Compatibility fallback used by previous releases when safeStorage is unavailable.
// Do not change this key or byte format: existing translation-config-encrypted.json files depend on it.
const ENCRYPTION_KEY = 'whisper-sub-translate-secure-key-2024-32bytes!!';
const ENCRYPTION_ALGORITHM = 'aes-256-cbc';

function safeStorageAvailable() {
  try {
    return !!(
      electronSafeStorage &&
      typeof electronSafeStorage.isEncryptionAvailable === 'function' &&
      electronSafeStorage.isEncryptionAvailable()
    );
  } catch (_error) {
    return false;
  }
}

function resolveConfigPath(filename, failureMessage) {
  try {
    if (electronApp && electronApp.getPath) {
      return path.join(electronApp.getPath('userData'), filename);
    }
  } catch (error) {
    console.log(failureMessage, error.message);
  }
  return path.resolve(__dirname, '../../..', filename);
}

function getSafeStorageConfigPath() {
  return resolveConfigPath('translation-config-safe.json', '[Config] Failed to get safeStorage config path:');
}

function getConfigPath() {
  return resolveConfigPath('translation-config.json', '[Config] Failed to get user data path:');
}

function getEncryptedConfigPath() {
  return resolveConfigPath('translation-config-encrypted.json', '[Config] Failed to get encrypted config path:');
}

function safeStorageEncryptJson(jsonText) {
  if (!safeStorageAvailable()) return null;
  try {
    return electronSafeStorage.encryptString(jsonText).toString('base64');
  } catch (error) {
    console.error('[safeStorage] encrypt failed:', error.message);
    return null;
  }
}

function safeStorageDecryptJson(base64Text) {
  if (!safeStorageAvailable()) return null;
  try {
    return electronSafeStorage.decryptString(Buffer.from(base64Text, 'base64'));
  } catch (error) {
    console.error('[safeStorage] decrypt failed:', error.message);
    return null;
  }
}

function encryptData(text) {
  try {
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    console.error('[Encryption] Failed:', error.message);
    return null;
  }
}

function decryptData(encryptedText) {
  try {
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    const parts = encryptedText.split(':');
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(parts[0], 'hex'));
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('[Decryption] Failed:', error.message);
    return null;
  }
}

function migratePlaintextConfig() {
  const configPath = getConfigPath();
  const encryptedConfigPath = getEncryptedConfigPath();

  if (fs.existsSync(configPath) && !fs.existsSync(encryptedConfigPath)) {
    try {
      console.log('[Migration] Found plaintext config, migrating to encrypted storage...');
      const plainConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const encryptedData = encryptData(JSON.stringify(plainConfig));
      if (encryptedData) {
        fs.writeFileSync(encryptedConfigPath, JSON.stringify({ data: encryptedData }));
        console.log('[Migration] Removing plaintext config after successful migration');
        try {
          fs.rmSync(configPath, { force: true });
        } catch (cleanupError) {
          console.warn('[Migration] Failed to remove plaintext config:', cleanupError.message);
        }
        console.log('[Migration] Success! API keys are now stored securely with encryption');
        return true;
      }
    } catch (error) {
      console.error('[Migration] Failed to migrate plaintext config:', error.message);
      return false;
    }
  }
  return false;
}

function loadConfig(hydrate, getDefault) {
  migratePlaintextConfig();

  const safePath = getSafeStorageConfigPath();
  if (safeStorageAvailable() && fs.existsSync(safePath)) {
    try {
      const payload = JSON.parse(fs.readFileSync(safePath, 'utf8'));
      const decrypted = safeStorageDecryptJson(payload.data);
      if (decrypted) return hydrate(JSON.parse(decrypted));
    } catch (error) {
      console.error('[Config] Failed to load safeStorage config:', error.message);
    }
  }

  const encryptedConfigPath = getEncryptedConfigPath();
  try {
    if (fs.existsSync(encryptedConfigPath)) {
      const encryptedFile = JSON.parse(fs.readFileSync(encryptedConfigPath, 'utf8'));
      const decrypted = decryptData(encryptedFile.data);
      if (decrypted) {
        const hydrated = hydrate(JSON.parse(decrypted));
        if (safeStorageAvailable()) {
          try {
            const reencrypted = safeStorageEncryptJson(JSON.stringify(hydrated));
            if (reencrypted) {
              fs.writeFileSync(safePath, JSON.stringify({ data: reencrypted }));
              try {
                fs.rmSync(encryptedConfigPath, { force: true });
              } catch (_error) {
                /* noop */
              }
              console.log('[Config] Migrated legacy AES config to safeStorage:', safePath);
            }
          } catch (error) {
            console.warn('[Config] safeStorage migration failed:', error.message);
          }
        }
        return hydrated;
      }
    }
  } catch (error) {
    console.error('[Config] Failed to load encrypted config:', error.message);
  }

  return getDefault();
}

function saveConfig(keys, hydrate, getDefault) {
  try {
    const existingConfig = loadConfig(hydrate, getDefault);
    const newConfig = { ...existingConfig, ...keys };
    const json = JSON.stringify(newConfig);

    if (safeStorageAvailable()) {
      const encryptedSafe = safeStorageEncryptJson(json);
      if (encryptedSafe) {
        fs.writeFileSync(getSafeStorageConfigPath(), JSON.stringify({ data: encryptedSafe }));
        console.log('[Config] API keys saved via Electron safeStorage');
        return { result: true, config: loadConfig(hydrate, getDefault) };
      }
      console.warn('[Config] safeStorage save failed, falling back to legacy AES');
    }

    console.warn(
      '[Security] API keys stored with legacy AES fallback using a HARDCODED key ' +
        '(safeStorage/OS keyring unavailable). Keys are recoverable by anyone with the ' +
        'app source - NOT secure. Use a desktop session with a keyring (e.g. gnome-keyring).'
    );
    const encryptedData = encryptData(json);
    if (!encryptedData) throw new Error('Encryption failed');
    fs.writeFileSync(getEncryptedConfigPath(), JSON.stringify({ data: encryptedData }));
    console.warn('[Config] API keys saved via legacy AES fallback (INSECURE - hardcoded key)');
    return { result: { success: true, insecure: true }, config: loadConfig(hydrate, getDefault) };
  } catch (error) {
    console.error('[Config] Failed to save API keys:', error.message);
    return { result: false, config: null };
  }
}

module.exports = { loadConfig, saveConfig };
