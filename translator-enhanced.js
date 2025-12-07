const axios = require('axios');
const deepl = require('deepl-node');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MyMemoryTranslator = require('./myMemoryTranslator');

let electronApp = null;
try {
  const { app } = require('electron');
  electronApp = app;
} catch (error) {
  console.log('[Translator] Running without Electron app context:', error.message);
}

// Encryption settings (암호화 설정)
const ENCRYPTION_KEY = 'whisper-sub-translate-secure-key-2024-32bytes!!';
const ENCRYPTION_ALGORITHM = 'aes-256-cbc';

function getConfigPath() {
  try {
    if (electronApp && electronApp.getPath) {
      const base = electronApp.getPath('userData');
      return path.join(base, 'translation-config.json');
    }
  } catch (error) {
    console.log('[Config] Failed to get user data path:', error.message);
  }
  return path.join(__dirname, 'translation-config.json');
}

function getEncryptedConfigPath() {
  try {
    if (electronApp && electronApp.getPath) {
      const base = electronApp.getPath('userData');
      return path.join(base, 'translation-config-encrypted.json');
    }
  } catch (error) {
    console.log('[Config] Failed to get encrypted config path:', error.message);
  }
  return path.join(__dirname, 'translation-config-encrypted.json');
}

// Encrypt data (데이터 암호화)
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

// Decrypt data (데이터 복호화)
function decryptData(encryptedText) {
  try {
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('[Decryption] Failed:', error.message);
    return null;
  }
}

// Migrate from plaintext to encrypted storage (평문에서 암호화 저장소로 마이그레이션)
function migratePlaintextConfig() {
  const configPath = getConfigPath();
  const encryptedConfigPath = getEncryptedConfigPath();

  if (fs.existsSync(configPath) && !fs.existsSync(encryptedConfigPath)) {
    try {
      console.log('[Migration] Found plaintext config, migrating to encrypted storage...');
      const plainConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      // Encrypt and save
      const encryptedData = encryptData(JSON.stringify(plainConfig));
      if (encryptedData) {
        fs.writeFileSync(encryptedConfigPath, JSON.stringify({ data: encryptedData }));

        // Backup plaintext file
        const backupPath = configPath + '.backup';
        fs.renameSync(configPath, backupPath);

        console.log('[Migration] Success! Plaintext file backed up to:', backupPath);
        console.log('[Migration] API keys are now stored securely with encryption');
        return true;
      }
    } catch (error) {
      console.error('[Migration] Failed to migrate plaintext config:', error.message);
      return false;
    }
  }

  return false;
}

class EnhancedSubtitleTranslator {
  constructor() {
    this.deeplTranslator = null;
    this.myMemoryTranslator = new MyMemoryTranslator();
    this.apiKeys = this.loadApiKeys();
    this.translationCache = new Map();
    this.currentFileId = null;       // 현재 처리 중인 파일 ID (파일별 캐시 격리용)
    this.lastRequestTime = 0;
    this.minRequestInterval = 20;    // 50ms → 20ms (더 빠르게)
    this.maxRetries = 3;             // 번역 실패 최소화를 위해 재시도 횟수 증가
    this.batchSize = 5;              // 3 → 5 (5개씩 묶어서 처리)
    this.mainWindow = null;          // mainWindow 참조 저장
  }

  // MainWindow에 메시지 전송 헬퍼
  sendToMainWindow(channel, data) {
    try {
      if (this.mainWindow && this.mainWindow.webContents) {
        this.mainWindow.webContents.send(channel, data);
      }
    } catch (error) {
      console.log(`[UI Update Failed] ${error.message}`);
    }
  }

  // MainWindow 설정
  setMainWindow(window) {
    this.mainWindow = window;
  }

  // 현재 처리 중인 파일 설정 (파일별 캐시 격리)
  setCurrentFile(filePath) {
    if (filePath) {
      // 파일 경로를 간단한 ID로 변환 (파일명만 사용)
      const path = require('path');
      this.currentFileId = path.basename(filePath, path.extname(filePath));
      console.log(`[Cache] File-specific cache activated for: ${this.currentFileId}`);
    } else {
      this.currentFileId = null;
    }
  }

  // 파일 처리 완료 시 캐시 정리 (선택적)
  clearFileCache() {
    if (this.currentFileId) {
      console.log(`[Cache] Clearing cache for file: ${this.currentFileId}`);
      // 현재 파일의 캐시만 삭제
      const keysToDelete = [];
      for (const key of this.translationCache.keys()) {
        if (key.startsWith(`${this.currentFileId}_`)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => this.translationCache.delete(key));
      console.log(`[Cache] Removed ${keysToDelete.length} cached translations for ${this.currentFileId}`);
    }
    this.currentFileId = null;
  }

  loadApiKeys() {
    // Attempt migration from plaintext on first run (첫 실행 시 평문 마이그레이션 시도)
    migratePlaintextConfig();

    const encryptedConfigPath = getEncryptedConfigPath();

    try {
      if (fs.existsSync(encryptedConfigPath)) {
        const encryptedFile = JSON.parse(fs.readFileSync(encryptedConfigPath, 'utf8'));
        const decrypted = decryptData(encryptedFile.data);

        if (decrypted) {
          const config = JSON.parse(decrypted);
          return {
            deepl: config.deepl || '',
            openai: config.openai || '',
            deepseek: config.deepseek || '',
            preferredService: config.preferredService || 'mymemory',
            enableCache: config.enableCache !== false,
            batchTranslation: config.batchTranslation !== false,
            maxConcurrent: config.maxConcurrent || this.getOptimalConcurrency()
          };
        }
      }
    } catch (error) {
      console.error('[Config] Failed to load encrypted config:', error.message);
    }

    return this.getDefaultConfig();
  }

  getDefaultConfig() {
    return {
      deepl: '',
      openai: '',
      deepseek: '',
      preferredService: 'mymemory',
      enableCache: true,
      batchTranslation: true,
      maxConcurrent: this.getOptimalConcurrency()
    };
  }

  // 저사양 PC 대응 - 시스템 성능에 따른 최적 동시 처리 수 (더 공격적으로 설정)
  getOptimalConcurrency() {
    try {
      const os = require('os');
      const totalMemGB = os.totalmem() / 1024 / 1024 / 1024;
      const cpuCount = os.cpus().length;

      // 메모리 기준 조정 (더 공격적으로 설정하여 속도 개선)
      let concurrency = 3; // 기본값 (2→3)

      if (totalMemGB >= 16 && cpuCount >= 8) {
        concurrency = 10; // 고사양 PC (4→10)
      } else if (totalMemGB >= 8 && cpuCount >= 4) {
        concurrency = 6; // 중고사양 PC (4→6)
      } else if (totalMemGB >= 4 && cpuCount >= 2) {
        concurrency = 4; // 중사양 PC (3→4)
      } else {
        concurrency = 2; // 저사양 PC (1→2)
      }

      console.log(`[Performance] Detected: ${totalMemGB.toFixed(1)}GB RAM, ${cpuCount} CPU cores → Max concurrent: ${concurrency}`);
      return concurrency;

    } catch (error) {
      console.warn('[Performance] Failed to detect system specs, using safe default (3)');
      return 3;
    }
  }

  // 서비스별 최적 배치 크기 (더 공격적으로 설정하여 속도 개선)
  getOptimalBatchSize(service) {
    const batchSizes = {
      'mymemory': 10,  // 무료 서비스 - 많이 묶어서 처리 (5→10)
      'deepl': 8,      // 유료 API - 더 큰 배치 (3→8)
      'chatgpt': 5,    // 고급 모델 - 중간 배치 (2→5)
      'offline': 15    // 오프라인 - 가장 큰 배치 (네트워크 없음)
    };

    return batchSizes[service] || 8; // 기본값 3→8
  }

  saveApiKeys(keys) {
    const encryptedConfigPath = getEncryptedConfigPath();

    try {
      // Load existing config
      const existingConfig = this.loadApiKeys();
      const newConfig = { ...existingConfig, ...keys };

      // Encrypt and save
      const encryptedData = encryptData(JSON.stringify(newConfig));
      if (encryptedData) {
        fs.writeFileSync(encryptedConfigPath, JSON.stringify({ data: encryptedData }));

        // Reload keys
        this.apiKeys = this.loadApiKeys();

        if (this.apiKeys.deepl) {
          this.deeplTranslator = new deepl.Translator(this.apiKeys.deepl);
        }

        console.log('[Config] API keys saved securely with encryption');
        return true;
      } else {
        throw new Error('Encryption failed');
      }
    } catch (error) {
      console.error('[Config] Failed to save API keys:', error.message);
      return false;
    }
  }

  // Cache system with per-file isolation (파일별 캐시 격리 시스템)
  getCacheKey(text, method, targetLang) {
    // 파일별 캐시 격리: 파일 ID를 캐시 키에 포함
    const filePrefix = this.currentFileId ? `${this.currentFileId}_` : '';
    return `${filePrefix}${method}_${targetLang}_${this.hashString(text)}`;
  }

  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // convert to 32-bit integer (32비트 정수로 변환)
    }
    return hash.toString();
  }

  getCachedTranslation(text, method, targetLang) {
    if (!this.apiKeys.enableCache) return null;
    const key = this.getCacheKey(text, method, targetLang);
    const cached = this.translationCache.get(key);

    // LRU: Move to end (most recently used) (최근 사용으로 갱신)
    if (cached !== undefined) {
      this.translationCache.delete(key);
      this.translationCache.set(key, cached);
    }

    return cached;
  }

  setCachedTranslation(text, method, targetLang, translation) {
    if (!this.apiKeys.enableCache) return;
    const key = this.getCacheKey(text, method, targetLang);

    // LRU: Remove if exists, then add to end (최신으로 갱신)
    if (this.translationCache.has(key)) {
      this.translationCache.delete(key);
    }

    this.translationCache.set(key, translation);

    // LRU Cache size limit (1000 items) - Remove least recently used (캐시 크기 제한 1000개 - 가장 오래 사용 안 한 것 삭제)
    if (this.translationCache.size > 1000) {
      const firstKey = this.translationCache.keys().next().value;
      this.translationCache.delete(firstKey);
      console.log('[Cache] LRU eviction - removed least recently used item');
    }
  }

  // API rate limiting (API 요청 제한)
  async throttleRequest() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.minRequestInterval) {
      await this.sleep(this.minRequestInterval - timeSinceLastRequest);
    }
    
    this.lastRequestTime = Date.now();
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Enhanced error handling (향상된 에러 처리)
  logError(context, error) {
    const errorInfo = {
      timestamp: new Date().toISOString(),
      context,
      error: error.message,
      stack: error.stack
    };
    console.error('[Translation Error / 번역 오류]', errorInfo);
  }

  // Translation with retry (재시도 로직)
  async translateWithRetry(translateFn, text, maxRetries = this.maxRetries) {
    let lastError;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await this.sleep(1000 * Math.pow(2, attempt)); // exponential backoff (지수 백오프)
        }
        return await translateFn(text);
      } catch (error) {
        lastError = error;
        this.logError(`Translation attempt ${attempt + 1}/${maxRetries} failed (번역 시도 실패)`, error);
        
        // Do not retry on permanent errors (영구적 오류는 재시도 안함)
        if (error.message.includes('401') || error.message.includes('403')) {
          break;
        }
      }
    }
    
    throw lastError;
  }

  // Improved DeepL translation (개선된 DeepL 번역)
  async translateWithDeepL(text, targetLang = 'KO') {
    if (!this.apiKeys.deepl) {
      throw new Error('DeepL API 키가 설정되지 않았습니다.');
    }

    // 캐시 확인
    const cached = this.getCachedTranslation(text, 'deepl', targetLang);
    if (cached) {
      console.log('[DeepL Cache Hit]', { 
        text: text.substring(0, 30) + '...', 
        cached: true 
      });
      return cached;
    }

    console.log('[DeepL Translation]', { 
      text: text.substring(0, 50) + '...', 
      targetLang,
      textLength: text.length 
    });

    await this.throttleRequest();

    try {
      if (!this.deeplTranslator) {
        this.deeplTranslator = new deepl.Translator(this.apiKeys.deepl);
      }

      const startTime = Date.now();
      const result = await this.deeplTranslator.translateText(text, null, targetLang);
      let translation = result.text;
      
      // 따옴표 제거 (앞뒤로 있는 따옴표들 제거)
      translation = translation.replace(/^["'"'「」『』]+|["'"'「」『』]+$/g, '');
      
      const duration = Date.now() - startTime;
      
      console.log('[DeepL Success]', { 
        original: text.substring(0, 30) + '...',
        translated: translation.substring(0, 30) + '...',
        duration: `${duration}ms`,
        chars: text.length
      });
      
      // 결과 캐시
      this.setCachedTranslation(text, 'deepl', targetLang, translation);
      return translation;
    } catch (error) {
      console.error('[DeepL Translation Failed]', {
        text: text.substring(0, 50) + '...',
        error: error.message
      });
      this.logError('DeepL 번역 실패', error);
      throw error;
    }
  }

  // OpenAI 번역 (GPT-4o-mini - 빠르고 저렴한 최신 모델)
  async translateWithChatGPT(text, targetLang = '한국어') {
    if (!this.apiKeys.openai) {
      throw new Error('OpenAI API 키가 설정되지 않았습니다.');
    }

    // 캐시 확인
    const cached = this.getCachedTranslation(text, 'chatgpt', targetLang);
    if (cached) {
      console.log('[GPT-4o-mini Cache Hit]', {
        text: text.substring(0, 30) + '...',
        cached: true
      });
      return cached;
    }

    console.log(`[GPT-4o-mini] "${text.substring(0, 40)}..." → ${targetLang}`);

    await this.throttleRequest();

    try {
      const startTime = Date.now();

      const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a professional subtitle translator specializing in natural, contextual translation to ${targetLang}.

CRITICAL RULES:
1. ALWAYS translate to ${targetLang} - never use English or other languages
2. PRESERVE proper names, character names, and place names as-is (don't translate names like "John", "Tokyo", "NASA")
3. Use natural, conversational ${targetLang} that native speakers would actually say
4. Consider the context and tone of the scene
5. TRANSLATE ALL CONTENT including profanity, sexual content, violence, and adult themes naturally without censorship or filtering

TRANSLATION GUIDELINES:
- Character names: Keep original but integrate naturally with ${targetLang} grammar
- Place names: Keep original but use natural ${targetLang} grammar and particles
- Brand names: Keep original with natural ${targetLang} grammar
- Technical terms: Use commonly accepted ${targetLang} terms
- Cultural references: Adapt naturally for ${targetLang} audience
- Emotions/tone: Match the speaker's mood (angry, sad, joking, etc.)
- Slang/informal speech: Use natural ${targetLang} equivalents
- Formal speech: Use appropriate formal ${targetLang}
- Profanity/vulgar language: Translate to equivalent ${targetLang} expressions naturally
- Sexual/adult content: Translate directly and naturally without euphemisms
- Violence/strong language: Maintain intensity and meaning in ${targetLang}
- Grammar: Use proper ${targetLang} grammar rules and particles with foreign names

STYLE ADAPTATION:
- Movies/Dramas: Emotional, natural dialogue including mature themes
- Action scenes: Short, punchy translations with strong language
- Comedy: Preserve humor and timing, including adult humor
- Romance: Emotional, heartfelt tone including intimate content
- Adult/R-rated content: Direct, unfiltered translation
- Documentaries: Clear, informative style
- Thriller/Horror: Maintain intensity and impact

IMPORTANT: Return ONLY the natural ${targetLang} translation without any quotation marks, brackets, or additional formatting.`
          },
          {
            role: 'user',
            content: `Translate this subtitle to natural, contextual ${targetLang}. Keep names and proper nouns as-is:\n\n"${text}"`
          }
        ],
        temperature: 0.3,
        max_tokens: Math.min(1500, text.length * 3)
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKeys.openai}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      let translation = response.data.choices[0].message.content.trim();

      // 따옴표 제거 (앞뒤로 있는 따옴표들 제거)
      translation = translation.replace(/^["'"'「」『』]+|["'"'「」『』]+$/g, '');

      const duration = Date.now() - startTime;

      console.log('[GPT-4o-mini OK]', {
        original: text.substring(0, 30) + '...',
        translated: translation.substring(0, 30) + '...',
        time: `${duration}ms`
      });

      // 결과 캐시
      this.setCachedTranslation(text, 'chatgpt', targetLang, translation);
      return translation;
    } catch (error) {
      console.error('[GPT-4o-mini Error]', error.message);
      this.logError('GPT-4o-mini 번역 실패', error);
      throw error;
    }
  }

  // 개선된 MyMemory 번역
  async translateWithMyMemory(text, targetLang = 'ko') {
    // 캐시 확인
    const cached = this.getCachedTranslation(text, 'mymemory', targetLang);
    if (cached) return cached;

    await this.throttleRequest();

    try {
      let result = await this.myMemoryTranslator.translate(text, 'auto', targetLang);
      
      // 따옴표 제거 (앞뒤로 있는 따옴표들 제거)
      result = result.replace(/^["'"'「」『』]+|["'"'「」『』]+$/g, '');
      
      // 결과 캐시
      this.setCachedTranslation(text, 'mymemory', targetLang, result);
      return result;
    } catch (error) {
      this.logError('MyMemory 번역 실패', error);
      throw error;
    }
  }

  // 스마트 자동 번역 (우선순위 + 폴백)
  async translateAuto(text, method = null, targetLang = null) {
    if (!text || !text.trim()) return text;
    
    const cleanText = text.trim();
    // 완전히 빈 텍스트만 건너뛰기 - 모든 텍스트를 번역 시도
    if (cleanText.length === 0) {
      return text;
    }

    const preferredMethod = method || this.apiKeys.preferredService;
    const targetLanguage = targetLang || (preferredMethod === 'deepl' ? 'KO' : 'ko');

    const methods = [
      { name: preferredMethod, lang: targetLanguage },
      { name: 'mymemory', lang: targetLanguage === 'KO' ? 'ko' : targetLanguage },
      { name: 'deepl', lang: targetLanguage === 'ko' ? 'KO' : targetLanguage },
      { name: 'chatgpt', lang: this.mapToHumanLang ? this.mapToHumanLang(targetLanguage) : '한국어' }
    ];

    const uniqueMethods = methods.filter((m, i, a) => a.findIndex(x => x.name === m.name) === i);

    for (const m of uniqueMethods) {
      try {
        switch (m.name) {
          case 'mymemory':
            return await this.translateWithRetry((t) => this.translateWithMyMemory(t, m.lang), text);
          case 'deepl':
            if (this.apiKeys.deepl && this.apiKeys.deepl.trim()) {
              return await this.translateWithRetry((t) => this.translateWithDeepL(t, m.lang), text);
            }
            break;
          case 'chatgpt':
            if (this.apiKeys.openai && this.apiKeys.openai.trim()) {
              return await this.translateWithRetry((t) => this.translateWithChatGPT(t, m.lang), text);
            }
            break;
        }
      } catch (err) {
        console.error(`[${m.name} Translation Failed] "${text.substring(0, 40)}..." - ${err.message}`);
        continue;
      }
    }
    
    // 모든 서비스가 실패했을 때 최후의 수단 - 기본 번역 서비스로 재시도
    console.warn(`[Final Attempt] All services failed, trying MyMemory as last resort: "${text.substring(0, 40)}..."`);
    try {
      return await this.translateWithMyMemory(text, 'ko');
    } catch (finalErr) {
      console.error(`[Final Attempt Failed] "${text.substring(0, 40)}..." - ${finalErr.message}`);
      // 정말 모든 방법이 실패한 경우에만 원문 반환
      return text;
    }
  }

  mapToHumanLang(targetLang) {
    // ChatGPT에 사람이 읽는 언어명 전달 (더 명확한 지시)
    const map = {
      ko: 'Korean (한국어)',
      en: 'English',
      ja: 'Japanese (日本語)',
      zh: 'Chinese (中文)',
      es: 'Spanish (Español)',
      fr: 'French (Français)',
      de: 'German (Deutsch)',
      it: 'Italian (Italiano)',
      pt: 'Portuguese (Português)',
      ru: 'Russian (Русский)',
      hu: 'Hungarian (Magyar)',
      ar: 'Arabic (العربية)',
      hi: 'Hindi (हिन्दी)',
      th: 'Thai (ไทย)',
      vi: 'Vietnamese (Tiếng Việt)',
      KO: 'Korean (한국어)',
      'ko-KR': 'Korean (한국어)',
      'korean': 'Korean (한국어)',
      'en-US': 'English',
      'ja-JP': 'Japanese (日本語)',
      'zh-CN': 'Chinese (中文)',
      'zh-TW': 'Traditional Chinese (繁體中文)'
    };
    return map[targetLang] || targetLang;
  }

  // 배치 번역 (성능 향상) - 동적 배치 크기 조정
  async translateBatch(texts, method = null, targetLang = null, sourceLang = null, progressCallback = null) {
    const preferredMethod = method || this.apiKeys.preferredService;
    
    if (!this.apiKeys.batchTranslation || texts.length <= 1) {
      // 배치 모드가 비활성화되어 있거나 텍스트가 1개 이하면 개별 번역
      const results = [];
      for (let i = 0; i < texts.length; i++) {
        try {
          console.log(`[Batch Translation] ${i + 1}/${texts.length}: ${texts[i].substring(0, 40)}...`);
          
          const result = await this.translateAuto(texts[i], method, targetLang);
          results.push(result);
          
          console.log(`[Batch Success] ${i + 1}/${texts.length}: ${result.substring(0, 40)}...`);
          
          // 진행률 업데이트
          if (progressCallback) {
            progressCallback({
              stage: 'translating',
              current: i + 1,
              total: texts.length,
              text: texts[i].substring(0, 50) + '...'
            });
          }
        } catch (error) {
          console.error(`[Batch Failed] ${i + 1}/${texts.length}: "${texts[i].substring(0, 40)}..." - ${error.message}`);
          
          // 실패한 텍스트에 대해 더 적극적인 재시도 (2회)
          let retryResult = texts[i]; // 기본값은 원문
          for (let retry = 1; retry <= 2; retry++) {
            try {
              console.log(`[Retry ${retry}/2] ${i + 1}/${texts.length}: ${texts[i].substring(0, 40)}...`);
              await new Promise(resolve => setTimeout(resolve, retry * 1000)); // 점진적 지연
              
              // 다른 번역 서비스로 시도
              const fallbackMethod = retry === 1 ? 'mymemory' : 'chatgpt';
              retryResult = await this.translateAuto(texts[i], fallbackMethod, targetLang);
              console.log(`[Retry ${retry} Success] ${i + 1}/${texts.length}: ${retryResult.substring(0, 40)}...`);
              break; // 성공하면 재시도 중단
            } catch (retryError) {
              console.error(`[Retry ${retry} Failed] ${i + 1}/${texts.length}: ${retryError.message}`);
              if (retry === 2) {
                console.warn(`[Give Up] ${i + 1}/${texts.length}: 모든 재시도 실패 - 원문 유지`);
              }
            }
          }
          
          results.push(retryResult);
        }
      }
      return results;
    }

    // 서비스별 최적 배치 크기
    const optimalBatchSize = this.getOptimalBatchSize(preferredMethod);
    console.log(`[Batch Processing] Using batch size: ${optimalBatchSize} for ${preferredMethod}`);
    
    // 배치 크기로 분할
    const batches = [];
    for (let i = 0; i < texts.length; i += optimalBatchSize) {
      batches.push(texts.slice(i, i + optimalBatchSize));
    }

    const results = [];
    const maxConcurrent = this.apiKeys.maxConcurrent;

    // 동시 처리 제한
    for (let i = 0; i < batches.length; i += maxConcurrent) {
      const concurrentBatches = batches.slice(i, i + maxConcurrent);
      
      const batchPromises = concurrentBatches.map(async (batch, batchIndex) => {
        const batchResults = [];
        for (let j = 0; j < batch.length; j++) {
          const text = batch[j];
          const currentIndex = results.length + batchIndex * optimalBatchSize + j + 1;
          
          try {
            console.log(`[Parallel Translation] ${currentIndex}/${texts.length}: ${text.substring(0, 40)}...`);
            
            const result = await this.translateAuto(text, method, targetLang);
            batchResults.push(result);
            
            console.log(`[Parallel Success] ${currentIndex}/${texts.length}: ${result.substring(0, 40)}...`);
            
            // 진행률 콜백 호출
            if (progressCallback) {
              progressCallback({
                stage: 'translating',
                current: currentIndex,
                total: texts.length,
                text: text.substring(0, 50) + '...'
              });
            }
          } catch (error) {
            console.error(`[Parallel Failed] ${currentIndex}/${texts.length}: "${text.substring(0, 40)}..." - ${error.message}`);
            
            // 실패한 텍스트에 대해 재시도 (1회)
            let retryResult = text; // 기본값은 원문
            try {
              console.log(`[Parallel Retry] ${currentIndex}/${texts.length}: ${text.substring(0, 40)}...`);
              await new Promise(resolve => setTimeout(resolve, 1000)); // 1초 대기
              retryResult = await this.translateAuto(text, method, targetLang);
              console.log(`[Parallel Retry Success] ${currentIndex}/${texts.length}: ${retryResult.substring(0, 40)}...`);
            } catch (retryError) {
              console.error(`[Parallel Retry Failed] ${currentIndex}/${texts.length}: ${retryError.message} - 원문 유지`);
            }
            
            batchResults.push(retryResult);
          }
        }
        return batchResults;
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.flat());
    }

    return results;
  }

  // 향상된 SRT 번역 (진행률 콜백 지원)
  async translateSRTFile(inputPath, outputPath, method = 'mymemory', targetLang = null, progressCallback = null, sourceLang = null) {
    try {
      const srtContent = fs.readFileSync(inputPath, 'utf8');
      const translatedContent = await this.translateSRTContent(srtContent, method, targetLang, progressCallback, sourceLang);
      
      fs.writeFileSync(outputPath, translatedContent, 'utf8');
      return outputPath;
    } catch (error) {
      this.logError('SRT 파일 번역 실패', error);
      throw error;
    }
  }

  // 비대사 부분 감지 (음악, 효과음, 빈 대사 등)
  isNonDialogue(text) {
    const trimmed = text.trim();

    // 빈 문자열
    if (!trimmed) return true;

    // 음악 기호만 있는 경우 (♪, ♫, ♬, ♩)
    if (/^[♪♫♬♩\s]+$/.test(trimmed)) return true;

    // 효과음/설명 대괄호 [...]만 있는 경우
    if (/^\[.*\]$/.test(trimmed)) return true;

    // 괄호만 있는 경우 (...)
    if (/^\(.*\)$/.test(trimmed)) return true;

    // 하이픈/대시만 있는 경우 (- - -, ---, etc)
    if (/^[-–—\s]+$/.test(trimmed)) return true;

    return false;
  }

  // 향상된 SRT 내용 번역 (배치 처리 + 진행률)
  async translateSRTContent(srtContent, method = 'mymemory', targetLang = null, progressCallback = null, sourceLang = null) {
    const lines = srtContent.split('\n');
    const translatedLines = [];
    const textsToTranslate = [];
    const textIndices = [];

    let i = 0;

    // 1단계: 번역할 텍스트 수집
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // 빈 줄 (원본 유지 - 공백 포함)
      if (!trimmed) {
        translatedLines.push(line);
        i++;
        continue;
      }

      // 자막 번호 (숫자만 있는 줄)
      if (/^\d+$/.test(trimmed)) {
        translatedLines.push(line);
        i++;
        continue;
      }

      // 타임코드 (00:00:00,000 --> 00:00:00,000)
      if (trimmed.includes('-->')) {
        translatedLines.push(line);
        i++;
        continue;
      }

      // 자막 텍스트 수집 (여러 줄 가능)
      let subtitleText = trimmed;
      let j = i + 1;

      while (j < lines.length) {
        const nextLine = lines[j].trim();

        // 빈 줄이면 자막 끝
        if (!nextLine) break;

        // 타임코드면 자막 끝
        if (nextLine.includes('-->')) break;

        // 숫자만 있으면 다음 자막 번호이므로 끝
        if (/^\d+$/.test(nextLine)) break;

        // 자막 텍스트 계속 수집
        subtitleText += '\n' + nextLine;
        j++;
      }

      // 비대사 부분은 번역하지 않고 원본 유지
      if (this.isNonDialogue(subtitleText)) {
        translatedLines.push(subtitleText);
        console.log('[Non-Dialogue] Skipping translation:', subtitleText.substring(0, 30) + '...');
      } else {
        // 번역 대상에 추가
        textsToTranslate.push(subtitleText);
        textIndices.push(translatedLines.length);
        translatedLines.push(null); // 나중에 채울 자리 예약
      }

      i = j;
    }

    // 2단계: 배치 번역
    if (progressCallback) {
      progressCallback({ stage: 'translating', current: 0, total: textsToTranslate.length });
    }

    const translatedTexts = await this.translateBatch(textsToTranslate, method, targetLang, sourceLang, progressCallback);

    // 3단계: 결과 삽입
    for (let k = 0; k < translatedTexts.length; k++) {
      const index = textIndices[k];
      translatedLines[index] = translatedTexts[k];
      
      if (progressCallback) {
        progressCallback({ 
          stage: 'translating', 
          current: k + 1, 
          total: textsToTranslate.length,
          text: textsToTranslate[k].substring(0, 50) + '...'
        });
      }
    }

    return translatedLines.join('\n');
  }

  // 향상된 API 키 검증
  async validateApiKeys() {
    const results = {
      deepl: false,
      openai: false,
      mymemory: true, // 항상 사용 가능
      errors: {},
      usage: {}
    };

    // DeepL 검사 (단순화된 검증)
    if (this.apiKeys.deepl && this.apiKeys.deepl.trim()) {
      try {
        const translator = new deepl.Translator(this.apiKeys.deepl.trim());
        
        // 사용량 정보 조회만으로 충분한 검증 (빠르고 확실함)
        const usage = await translator.getUsage();
        
        // 사용량 정보가 정상적으로 반환되면 유효한 키
        results.deepl = true;
        results.usage.deepl = {
          character: usage.character,
          limit: usage.character ? usage.character.limit : null
        };
        
        console.log('[DeepL Validation Success]', { 
          hasUsage: !!usage,
          characterCount: usage?.character?.count,
          characterLimit: usage?.character?.limit 
        });
        
      } catch (error) {
        console.error('[DeepL Validation Error]', error);
        results.deepl = false;
        results.errors.deepl = this.classifyError(error, 'deepl', 'ko');
      }
    } else {
      const errorMsg = this.getErrorMessages('ko');
      results.errors.deepl = errorMsg.noApiKey;
    }

    // OpenAI 검사 (GPT-4o Mini)
    if (this.apiKeys.openai && this.apiKeys.openai.trim()) {
      try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5
        }, {
          headers: {
            'Authorization': `Bearer ${this.apiKeys.openai.trim()}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        });
        results.openai = true;
      } catch (error) {
        results.errors.openai = this.classifyError(error, 'openai', 'ko');
      }
    } else {
      const errorMsg = this.getErrorMessages('ko');
      results.errors.openai = errorMsg.noApiKey;
    }

    return results;
  }

  // 다국어 에러 메시지
  getErrorMessages(lang = 'ko') {
    const messages = {
      ko: {
        invalidApiKey: 'API 키가 잘못되었습니다. 올바른 키를 입력해주세요.',
        quotaExceeded: '무료 한도를 초과했습니다. 다음 달에 다시 시도해주세요.',
        accessDenied: '접근이 거부되었습니다. API 키 권한을 확인해주세요.',
        tooManyRequests: '너무 많은 요청입니다. 잠시 후 다시 시도해주세요.',
        serverError: '서버 오류입니다. 잠시 후 다시 시도해주세요.',
        timeout: '요청 시간이 초과되었습니다. 네트워크 연결을 확인해주세요.',
        connectionError: '연결 오류',
        noApiKey: 'API 키가 입력되지 않았습니다.'
      },
      en: {
        invalidApiKey: 'Invalid API key. Please enter a correct key.',
        quotaExceeded: 'Free quota exceeded. Please try again next month.',
        accessDenied: 'Access denied. Please check your API key permissions.',
        tooManyRequests: 'Too many requests. Please try again later.',
        serverError: 'Server error. Please try again later.',
        timeout: 'Request timeout. Please check your network connection.',
        connectionError: 'Connection error',
        noApiKey: 'API key not entered.'
      },
      ja: {
        invalidApiKey: 'APIキーが無効です。正しいキーを入力してください。',
        quotaExceeded: '無料枠を超過しました。来月再度お試しください。',
        accessDenied: 'アクセスが拒否されました。APIキーの権限を確認してください。',
        tooManyRequests: 'リクエストが多すぎます。しばらく後に再度お試しください。',
        serverError: 'サーバーエラーです。しばらく後に再度お試しください。',
        timeout: 'リクエストタイムアウトです。ネットワーク接続を確認してください。',
        connectionError: '接続エラー',
        noApiKey: 'APIキーが入力されていません。'
      },
      zh: {
        invalidApiKey: 'API密钥无效。请输入正确的密钥。',
        quotaExceeded: '超出免费配额。请下个月重试。',
        accessDenied: '访问被拒绝。请检查您的API密钥权限。',
        tooManyRequests: '请求过多。请稍后重试。',
        serverError: '服务器错误。请稍后重试。',
        timeout: '请求超时。请检查您的网络连接。',
        connectionError: '连接错误',
        noApiKey: '未输入API密钥。'
      }
    };
    return messages[lang] || messages.ko;
  }

  // 에러 분류
  classifyError(error, service, lang = 'ko') {
    const message = error.message || '';
    const status = error.response?.status;
    const errorMsg = this.getErrorMessages(lang);
    
    // DeepL 특수 에러 처리
    if (message.includes('Authentication failed') || message.includes('auth_key')) {
      return errorMsg.invalidApiKey;
    }
    
    switch (status) {
      case 401:
        return errorMsg.invalidApiKey;
      case 403:
        return service === 'deepl' ? errorMsg.quotaExceeded : errorMsg.accessDenied;
      case 429:
        return errorMsg.tooManyRequests;
      case 500:
      case 502:
      case 503:
        return errorMsg.serverError;
      default:
        if (message.includes('timeout')) {
          return errorMsg.timeout;
        }
        return `${errorMsg.connectionError}: ${message}`;
    }
  }

  // 캐시 관리
  clearCache() {
    this.translationCache.clear();
    console.log('번역 캐시가 초기화되었습니다.');
  }

  getCacheStats() {
    return {
      size: this.translationCache.size,
      maxSize: 1000,
      hitRate: this.cacheHits / (this.cacheHits + this.cacheMisses) || 0
    };
  }
}

module.exports = EnhancedSubtitleTranslator;