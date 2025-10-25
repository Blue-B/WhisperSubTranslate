const axios = require('axios');

// Free translation via MyMemory API (≈50K chars/day/IP) (MyMemory API를 사용한 무료 번역)
class MyMemoryTranslator {
    constructor() {
        this.apiUrl = 'https://api.mymemory.translated.net/get';
        this.emailIndex = 1;
        this.maxRetries = 10; // 최대 10개 이메일 시도
    }

    // Generate pseudo emails; rotate on quota exceed (이메일 생성, 한도 초과 시 변경)
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
                console.log(`Translation attempt ${attempts + 1} (번역 시도): ${email.substring(0, 10)}...`);
                
                // Language code mapping (언어 코드 변환)
                const fromLang = this.getLanguageCode(sourceLang);
                const toLang = this.getLanguageCode(targetLang);
                
                const params = {
                    q: text,
                    langpair: `${fromLang}|${toLang}`,
                    de: email
                };

                const response = await axios.get(this.apiUrl, { params });
                
                if (response.data && response.data.responseData) {
                    // Keep current email index on success (성공 시 현재 이메일 유지)
                    return response.data.responseData.translatedText;
                } else if (response.data && response.data.responseStatus === 403) {
                    // On quota exceed, rotate to next email (한도 초과 시 다음 이메일 사용)
                    console.log('한도 초과, 다음 이메일로 시도...');
                    this.emailIndex++;
                    attempts++;
                    continue;
                } else {
                    throw new Error('Unable to get translation result (번역 결과 수신 실패)');
                }
            } catch (error) {
                console.log(`Translation failed: ${error.message} (번역 실패), retrying with next email...`);
                this.emailIndex++;
                attempts++;
                
                if (attempts >= this.maxRetries) {
                    throw new Error(`All email attempts failed (${this.maxRetries}) (모든 이메일 시도 실패)`);
                }
                
                // Wait briefly then retry (잠시 대기 후 재시도)
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        throw new Error('Translation quota exceeded, please try again later (번역 한도 초과)');
    }

    getLanguageCode(lang) {
        const langMap = {
            'auto': 'autodetect',
            'ko': 'ko',
            'en': 'en',
            'ja': 'ja',
            'zh': 'zh',
            'es': 'es',
            'fr': 'fr',
            'de': 'de',
            'it': 'it',
            'pt': 'pt',
            'ru': 'ru',
            'hu': 'hu',
            'ar': 'ar'
        };
        return langMap[lang] || lang;
    }
}

module.exports = MyMemoryTranslator;