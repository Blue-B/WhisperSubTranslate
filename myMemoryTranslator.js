const axios = require('axios');

// Free translation via MyMemory API (≈50K chars/day/IP)
class MyMemoryTranslator {
  constructor() {
    this.apiUrl = 'https://api.mymemory.translated.net/get';
    this.emailIndex = 1;
    this.maxRetries = 10;
  }

  // Generate pseudo emails; rotate on quota exceed
  generateEmail() {
    const emailTemplates = [
      `user${this.emailIndex}@example.com`,
      `translate${this.emailIndex}@gmail.com`,
      `subtitle${this.emailIndex}@yahoo.com`,
      `video${this.emailIndex}@hotmail.com`,
      `media${this.emailIndex}@outlook.com`,
    ];
    const randomTemplate = emailTemplates[Math.floor(Math.random() * emailTemplates.length)];
    return randomTemplate;
  }

  async translate(text, sourceLang = 'auto', targetLang = 'ko') {
    let attempts = 0;

    while (attempts < this.maxRetries) {
      try {
        const email = this.generateEmail();
        console.log(`[MyMemory] Attempt ${attempts + 1}/${this.maxRetries}: ${email.substring(0, 10)}...`);

        // Language code mapping
        const fromLang = this.getLanguageCode(sourceLang);
        const toLang = this.getLanguageCode(targetLang);

        const params = {
          q: text,
          langpair: `${fromLang}|${toLang}`,
          de: email,
        };

        const response = await axios.get(this.apiUrl, { params, timeout: 30000 });

        if (response.data && response.data.responseData) {
          const translatedText = response.data.responseData.translatedText;
          // MyMemory는 실패해도 HTTP 200 + 에러 문구를 translatedText로 돌려준다(이슈 #42).
          // 이 문구들이 자막 파일에 그대로 기록되지 않게 검증한다.
          const status = response.data.responseStatus;
          // 403은 responseData와 함께 오기도 한다. 에러 문구 검증 전에
          // 로테이션 분기로 보낸다 (이메일 교체 재시도, 무한 스핀 방지 sleep 포함).
          if (status === 403) {
            console.log('[MyMemory] Quota exceeded (403), trying next email...');
            this.emailIndex++;
            attempts++;
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
          if (status !== 200) {
            throw new Error(`MyMemory returned status ${status}`);
          }
          if (typeof translatedText === 'string') {
            const upper = translatedText.trim().toUpperCase();
            // MyMemory가 실제로 돌려주는 오류 문구(이슈 #42).
            // 전체 대문자 정규식은 대문자 자막(타이틀 등)을 오탐하므로
            // 알려진 문구 접두사만 검사한다.
            const MYMEMORY_ERROR_PREFIXES = [
              'PLEASE SELECT TWO DISTINCT LANGUAGES',
              'NO QUERY SPECIFIED',
              'MYMEMORY WARNING:',
              'INVALID LANGUAGE PAIR',
              'QUERY LENGTH LIMIT EXCEEDED',
              'ANONYMOUS USERS CAN ONLY',
              'DAILY LIMIT',
            ];
            // 영구 오류: 이메일을 바꿔도 성공할 수 없는 입력/설정 오류라
            // 10회 재시도+1초 sleep은 무료 할당량만 태운다. 1회차에 즉시 던진다.
            const PERMANENT_ERROR_PREFIXES = [
              'PLEASE SELECT TWO DISTINCT LANGUAGES',
              'NO QUERY SPECIFIED',
              'INVALID LANGUAGE PAIR',
              'QUERY LENGTH LIMIT EXCEEDED',
            ];
            if (PERMANENT_ERROR_PREFIXES.some((p) => upper.startsWith(p))) {
              throw new Error(
                `MyMemory returned an error message instead of a translation (permanent, not retried): ${translatedText
                  .trim()
                  .substring(0, 80)}`
              );
            }
            if (MYMEMORY_ERROR_PREFIXES.some((p) => upper.startsWith(p))) {
              throw new Error(
                `MyMemory returned an error message instead of a translation: ${translatedText.trim().substring(0, 80)}`
              );
            }
          }
          return translatedText;
        } else if (response.data && response.data.responseStatus === 403) {
          // Quota exceeded, try next email
          console.log('[MyMemory] Quota exceeded, trying next email...');
          this.emailIndex++;
          attempts++;
          // 403 로테이션도 1초 지연: 무한 스핀 방지
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        } else {
          throw new Error('Unable to get translation result');
        }
      } catch (error) {
        // 영구 오류(입력/설정 문제)는 재시도해도 성공할 수 없으므로 즉시 전파한다.
        if (String(error?.message || '').includes('permanent, not retried')) {
          throw error;
        }
        console.log(`[MyMemory] Failed: ${error.message}, retrying...`);
        this.emailIndex++;
        attempts++;

        if (attempts >= this.maxRetries) {
          // 원인 구분: 403/429/쿼터 문구면 "할당량 초과", 그 외(네트워크/타임아웃
          // 등 일시 장애)면 원래 에러 메시지를 전달한다. 일시 장애를 할당량으로
          // 오판하면 직렬 번역이 즉시 하드 스톱된다(F2).
          const msg = String(error?.message || error || '');
          const lower = msg.toLowerCase();
          if (
            lower.includes('status 403') ||
            lower.includes('status 429') ||
            /quota|daily limit|too many requests/.test(lower)
          ) {
            // renderer.js의 'MyMemory daily quota exceeded' 분기가 매칭되도록
            // 'daily quota' 문구를 유지한다 (그 외 'quota exceeded' 폴백 분기도 동작).
            throw new Error(
              `MyMemory daily quota exceeded (${msg.substring(0, 80)}). Try again tomorrow or use DeepL/OpenAI.`
            );
          }
          throw error;
        }

        // Wait briefly then retry
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    throw new Error('MyMemory daily quota exceeded. Try again tomorrow or use DeepL/OpenAI.');
  }

  getLanguageCode(lang) {
    const langMap = {
      auto: 'autodetect',
      ko: 'ko',
      en: 'en',
      ja: 'ja',
      zh: 'zh',
      es: 'es',
      fr: 'fr',
      de: 'de',
      it: 'it',
      pt: 'pt',
      ru: 'ru',
      hu: 'hu',
      ar: 'ar',
      pl: 'pl',
      fa: 'fa',
    };
    return langMap[lang] || lang;
  }
}

module.exports = MyMemoryTranslator;
