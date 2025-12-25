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
                    de: email
                };

                const response = await axios.get(this.apiUrl, { params });
                
                if (response.data && response.data.responseData) {
                    return response.data.responseData.translatedText;
                } else if (response.data && response.data.responseStatus === 403) {
                    // Quota exceeded, try next email
                    console.log('[MyMemory] Quota exceeded, trying next email...');
                    this.emailIndex++;
                    attempts++;
                    continue;
                } else {
                    throw new Error('Unable to get translation result');
                }
            } catch (error) {
                console.log(`[MyMemory] Failed: ${error.message}, retrying...`);
                this.emailIndex++;
                attempts++;

                if (attempts >= this.maxRetries) {
                    throw new Error(`MyMemory daily quota exceeded. Try again tomorrow or use DeepL/OpenAI.`);
                }

                // Wait briefly then retry
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        throw new Error('MyMemory daily quota exceeded. Try again tomorrow or use DeepL/OpenAI.');
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