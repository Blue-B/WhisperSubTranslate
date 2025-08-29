const axios = require('axios');
const deepl = require('deepl-node');
const fs = require('fs');
const path = require('path');
const MyMemoryTranslator = require('./myMemoryTranslator');

let electronApp = null;
try {
  const { app } = require('electron');
  electronApp = app;
} catch {}

function getConfigPath() {
  try {
    if (electronApp && electronApp.getPath) {
      const base = electronApp.getPath('userData');
      return path.join(base, 'translation-config.json');
    }
  } catch {}
  return path.join(__dirname, 'translation-config.json');
}

class EnhancedSubtitleTranslator {
  constructor() {
    this.deeplTranslator = null;
    this.myMemoryTranslator = new MyMemoryTranslator();
    this.apiKeys = this.loadApiKeys();
    this.translationCache = new Map();
    this.lastRequestTime = 0;
    this.minRequestInterval = 50;    // 100ms → 50ms (2배 빨라짐)
    this.maxRetries = 3;             // 번역 실패 최소화를 위해 재시도 횟수 증가
    this.batchSize = 3;              // 1 → 3 (3개씩 묶어서 처리)
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

  loadApiKeys() {
    const configPath = getConfigPath();
    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
    } catch (error) {
      this.logError('Failed to load API key config (API 키 설정 파일 로드 실패)', error);
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

  // 저사양 PC 대응 - 시스템 성능에 따른 최적 동시 처리 수
  getOptimalConcurrency() {
    try {
      const os = require('os');
      const totalMemGB = os.totalmem() / 1024 / 1024 / 1024;
      const cpuCount = os.cpus().length;
      
      // 메모리 기준 조정
      let concurrency = 2; // 기본값 (안전한 설정)
      
      if (totalMemGB >= 8 && cpuCount >= 4) {
        concurrency = 4; // 고사양 PC
      } else if (totalMemGB >= 4 && cpuCount >= 2) {
        concurrency = 3; // 중사양 PC  
      } else {
        concurrency = 1; // 저사양 PC (안전 우선)
      }
      
      console.log(`[Performance] Detected: ${totalMemGB.toFixed(1)}GB RAM, ${cpuCount} CPU cores → Max concurrent: ${concurrency}`);
      return concurrency;
      
    } catch (error) {
      console.warn('[Performance] Failed to detect system specs, using safe default (2)');
      return 2;
    }
  }

  // 서비스별 최적 배치 크기
  getOptimalBatchSize(service) {
    const batchSizes = {
      'mymemory': 5,   // 무료 서비스 - 많이 묶어서 처리
      'deepl': 3,      // 유료 API - 중간 크기
      'chatgpt': 2     // 고급 모델 - 작은 배치 (품질 우선)
    };
    
    return batchSizes[service] || 3; // 기본값
  }

  saveApiKeys(keys) {
    const configPath = getConfigPath();
    try {
      const existingConfig = this.loadApiKeys();
      const newConfig = { ...existingConfig, ...keys };
      fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
      this.apiKeys = newConfig;
      if (newConfig.deepl) {
        this.deeplTranslator = new deepl.Translator(newConfig.deepl);
      }
      return true;
    } catch (error) {
      this.logError('Failed to save API key config (API 키 저장 실패)', error);
      return false;
    }
  }

  // Cache system (캐시 시스템)
  getCacheKey(text, method, targetLang) {
    return `${method}_${targetLang}_${this.hashString(text)}`;
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
    return this.translationCache.get(key);
  }

  setCachedTranslation(text, method, targetLang, translation) {
    if (!this.apiKeys.enableCache) return;
    const key = this.getCacheKey(text, method, targetLang);
    this.translationCache.set(key, translation);
    
    // Cache size limit (1000 items) (캐시 크기 제한 1000개)
    if (this.translationCache.size > 1000) {
      const firstKey = this.translationCache.keys().next().value;
      this.translationCache.delete(firstKey);
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

  // 개선된 OpenAI 번역
  async translateWithChatGPT(text, targetLang = '한국어') {
    if (!this.apiKeys.openai) {
      throw new Error('OpenAI API 키가 설정되지 않았습니다.');
    }

    // 캐시 확인
    const cached = this.getCachedTranslation(text, 'chatgpt', targetLang);
    if (cached) {
      console.log('[ChatGPT Cache Hit]', { 
        text: text.substring(0, 30) + '...', 
        cached: true 
      });
      return cached;
    }

    console.log(`[ChatGPT Translation] Target: "${targetLang}" | Text: "${text.substring(0, 50)}..." | Model: gpt-4o-mini`);

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
        temperature: 0.4,
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
      
      console.log('[ChatGPT Success]', { 
        original: text.substring(0, 30) + '...',
        translated: translation.substring(0, 30) + '...',
        duration: `${duration}ms`,
        chars: text.length,
        model: 'gpt-4o-mini'
      });
      
      // 결과 캐시
      this.setCachedTranslation(text, 'chatgpt', targetLang, translation);
      return translation;
    } catch (error) {
      console.error('[ChatGPT Translation Failed]', {
        text: text.substring(0, 50) + '...',
        error: error.message,
        model: 'gpt-4o-mini'
      });
      this.logError('ChatGPT 번역 실패', error);
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

  // 향상된 SRT 내용 번역 (배치 처리 + 진행률)
  async translateSRTContent(srtContent, method = 'mymemory', targetLang = null, progressCallback = null, sourceLang = null) {
    const lines = srtContent.split('\n');
    const translatedLines = [];
    const textsToTranslate = [];
    const textIndices = [];
    
    let i = 0;

    // 1단계: 번역할 텍스트 수집
    while (i < lines.length) {
      const line = lines[i].trim();
      
      if (!line) {
        translatedLines.push('');
        i++;
        continue;
      }

      if (/^\d+$/.test(line)) {
        translatedLines.push(line);
        i++;
        continue;
      }

      if (line.includes('-->')) {
        translatedLines.push(line);
        i++;
        continue;
      }

      // 자막 텍스트 수집
      let subtitleText = line;
      let j = i + 1;
      
      while (j < lines.length && lines[j].trim() && 
             !lines[j].includes('-->') && 
             !/^\d+$/.test(lines[j].trim())) {
        subtitleText += '\n' + lines[j].trim();
        j++;
      }

      textsToTranslate.push(subtitleText);
      textIndices.push(translatedLines.length);
      translatedLines.push(null); // 나중에 채울 자리 예약

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

    // OpenAI 검사
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