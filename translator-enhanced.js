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
    this.minRequestInterval = 100;
    this.maxRetries = 3;
    this.batchSize = 5;
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
          maxConcurrent: config.maxConcurrent || 3
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
      maxConcurrent: 3
    };
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
    if (cached) return cached;

    await this.throttleRequest();

    try {
      if (!this.deeplTranslator) {
        this.deeplTranslator = new deepl.Translator(this.apiKeys.deepl);
      }

      const result = await this.deeplTranslator.translateText(text, null, targetLang);
      const translation = result.text;
      
      // 결과 캐시
      this.setCachedTranslation(text, 'deepl', targetLang, translation);
      return translation;
    } catch (error) {
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
    if (cached) return cached;

    await this.throttleRequest();

    try {
      const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `당신은 전문 번역가입니다. 다음 텍스트를 ${targetLang}로 자연스럽게 번역해주세요. 직역보다는 의역을 통해 자연스러운 ${targetLang} 표현으로 변환하세요. 번역 결과만 반환하고 다른 설명은 하지 마세요.`
          },
          {
            role: 'user',
            content: text
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

      const translation = response.data.choices[0].message.content.trim();
      
      // 결과 캐시
      this.setCachedTranslation(text, 'chatgpt', targetLang, translation);
      return translation;
    } catch (error) {
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
      const result = await this.myMemoryTranslator.translate(text, 'auto', targetLang);
      
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
    if (text.trim().length < 2) return text;

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
        continue;
      }
    }
    throw new Error('모든 번역 서비스가 실패했습니다.');
  }

  mapToHumanLang(targetLang) {
    // ChatGPT에 사람이 읽는 언어명 전달
    const map = {
      ko: '한국어',
      en: '영어',
      ja: '일본어',
      zh: '중국어',
      es: '스페인어',
      fr: '프랑스어',
      de: '독일어',
      it: '이탈리아어',
      pt: '포르투갈어',
      ru: '러시아어',
      KO: '한국어'
    };
    return map[targetLang] || targetLang;
  }

  // 배치 번역 (성능 향상)
  async translateBatch(texts, method = null, targetLang = null, sourceLang = null) {
    if (!this.apiKeys.batchTranslation || texts.length <= 1) {
      // 배치 모드가 비활성화되어 있거나 텍스트가 1개 이하면 개별 번역
      const results = [];
      for (const text of texts) {
        try {
          const result = await this.translateAuto(text, method, targetLang);
          results.push(result);
        } catch (error) {
          results.push(text); // 실패 시 원문 유지
        }
      }
      return results;
    }

    // 배치 크기로 분할
    const batches = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      batches.push(texts.slice(i, i + this.batchSize));
    }

    const results = [];
    const maxConcurrent = this.apiKeys.maxConcurrent;

    // 동시 처리 제한
    for (let i = 0; i < batches.length; i += maxConcurrent) {
      const concurrentBatches = batches.slice(i, i + maxConcurrent);
      
      const batchPromises = concurrentBatches.map(async (batch) => {
        const batchResults = [];
        for (const text of batch) {
          try {
            const result = await this.translateAuto(text, method, targetLang);
            batchResults.push(result);
          } catch (error) {
            batchResults.push(text); // 실패 시 원문 유지
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

    const translatedTexts = await this.translateBatch(textsToTranslate, method, targetLang, sourceLang);

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

    // DeepL 검사
    if (this.apiKeys.deepl && this.apiKeys.deepl.trim()) {
      try {
        const translator = new deepl.Translator(this.apiKeys.deepl.trim());
        
        // 사용량 정보 조회
        const usage = await translator.getUsage();
        results.usage.deepl = {
          character: usage.character,
          limit: usage.character ? usage.character.limit : null
        };
        
        // 간단한 번역 테스트
        const result = await translator.translateText('test', null, 'ko');
        results.deepl = true;
      } catch (error) {
        results.errors.deepl = this.classifyError(error, 'deepl');
      }
    } else {
      results.errors.deepl = 'API 키가 입력되지 않았습니다.';
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
        results.errors.openai = this.classifyError(error, 'openai');
      }
    } else {
      results.errors.openai = 'API 키가 입력되지 않았습니다.';
    }

    return results;
  }

  // 에러 분류
  classifyError(error, service) {
    const message = error.message || '';
    const status = error.response?.status;
    
    switch (status) {
      case 401:
        return 'API 키가 잘못되었습니다. 올바른 키를 입력해주세요.';
      case 403:
        return service === 'deepl' ? 
          '무료 한도를 초과했습니다. 다음 달에 다시 시도해주세요.' :
          '접근이 거부되었습니다. API 키 권한을 확인해주세요.';
      case 429:
        return '너무 많은 요청입니다. 잠시 후 다시 시도해주세요.';
      case 500:
      case 502:
      case 503:
        return '서버 오류입니다. 잠시 후 다시 시도해주세요.';
      default:
        if (message.includes('timeout')) {
          return '요청 시간이 초과되었습니다. 네트워크 연결을 확인해주세요.';
        }
        return `연결 오류: ${message}`;
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