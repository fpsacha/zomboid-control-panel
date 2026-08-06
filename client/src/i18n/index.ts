import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// English translations
import enCommon from './locales/en/common.json';
import enNav from './locales/en/nav.json';
import enDashboard from './locales/en/dashboard.json';
import enPlayers from './locales/en/players.json';
import enConsole from './locales/en/console.json';
import enMods from './locales/en/mods.json';
import enBackups from './locales/en/backups.json';
import enSettings from './locales/en/settings.json';
import enErrors from './locales/en/errors.json';
import enChat from './locales/en/chat.json';
import enChunkCleaner from './locales/en/chunkCleaner.json';
import enDebug from './locales/en/debug.json';
import enDiscord from './locales/en/discord.json';
import enEvents from './locales/en/events.json';
import enLogin from './locales/en/login.json';
import enScheduler from './locales/en/scheduler.json';
import enServerConfig from './locales/en/serverConfig.json';
import enServerFinder from './locales/en/serverFinder.json';
import enServers from './locales/en/servers.json';
import enServerSetup from './locales/en/serverSetup.json';
import enSetup from './locales/en/setup.json';
import enWorldMap from './locales/en/worldMap.json';

// Chinese translations
import zhCommon from './locales/zh/common.json';
import zhNav from './locales/zh/nav.json';
import zhDashboard from './locales/zh/dashboard.json';
import zhPlayers from './locales/zh/players.json';
import zhConsole from './locales/zh/console.json';
import zhMods from './locales/zh/mods.json';
import zhBackups from './locales/zh/backups.json';
import zhSettings from './locales/zh/settings.json';
import zhErrors from './locales/zh/errors.json';
import zhChat from './locales/zh/chat.json';
import zhChunkCleaner from './locales/zh/chunkCleaner.json';
import zhDebug from './locales/zh/debug.json';
import zhDiscord from './locales/zh/discord.json';
import zhEvents from './locales/zh/events.json';
import zhLogin from './locales/zh/login.json';
import zhScheduler from './locales/zh/scheduler.json';
import zhServerConfig from './locales/zh/serverConfig.json';
import zhServerFinder from './locales/zh/serverFinder.json';
import zhServers from './locales/zh/servers.json';
import zhServerSetup from './locales/zh/serverSetup.json';
import zhSetup from './locales/zh/setup.json';
import zhWorldMap from './locales/zh/worldMap.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        translation: enCommon,
        common: enCommon,
        nav: enNav,
        dashboard: enDashboard,
        players: enPlayers,
        console: enConsole,
        mods: enMods,
        backups: enBackups,
        settings: enSettings,
        errors: enErrors,
        chat: enChat,
        chunkCleaner: enChunkCleaner,
        debug: enDebug,
        discord: enDiscord,
        events: enEvents,
        login: enLogin,
        scheduler: enScheduler,
        serverConfig: enServerConfig,
        serverFinder: enServerFinder,
        servers: enServers,
        serverSetup: enServerSetup,
        setup: enSetup,
        worldMap: enWorldMap,
      },
      zh: {
        translation: zhCommon,
        common: zhCommon,
        nav: zhNav,
        dashboard: zhDashboard,
        players: zhPlayers,
        console: zhConsole,
        mods: zhMods,
        backups: zhBackups,
        settings: zhSettings,
        errors: zhErrors,
        chat: zhChat,
        chunkCleaner: zhChunkCleaner,
        debug: zhDebug,
        discord: zhDiscord,
        events: zhEvents,
        login: zhLogin,
        scheduler: zhScheduler,
        serverConfig: zhServerConfig,
        serverFinder: zhServerFinder,
        servers: zhServers,
        serverSetup: zhServerSetup,
        setup: zhSetup,
        worldMap: zhWorldMap,
      },
    },
    fallbackLng: 'zh',
    defaultNS: 'translation',
    nsSeparator: ':',
    debug: false,
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: 'language',
    },
  });

i18n.on('languageChanged', (language) => {
  document.documentElement.lang = language.split('-')[0];
});
document.documentElement.lang = i18n.language.split('-')[0];

export default i18n;
