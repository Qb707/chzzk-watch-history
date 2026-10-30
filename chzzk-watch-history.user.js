// ==UserScript==
// @name         봉누도 시청 기록 관리 - 치지직
// @namespace    https://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/Qb707/chzzk-watch-history/main/chzzk-watch-history.user.js
// @downloadURL  https://raw.githubusercontent.com/Qb707/chzzk-watch-history/main/chzzk-watch-history.user.js
// @version      2.9.5
// @description  치지직 다시보기 시청 기록 관리 - 시리즈별 독립 기록 및 시청 위치 복구
// @author       Qb
// @match        https://chzzk.naver.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.chzzk.naver.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // 기존 저장 키는 마이그레이션/백업을 위해 그대로 보존합니다.
    const LEGACY_STORAGE_KEY = 'bongnudo_watch_data_v2';
    const SERIES_META_KEY = 'bongnudo_watch_series_v1';
    const SERIES_DATA_PREFIX = 'bongnudo_watch_series_data_v1_';

    // 온라인 동기화 설정은 Tampermonkey의 로컬 저장소에만 보관합니다.
    const ONLINE_URL_KEY = 'bongnudo_online_url_v1';
    const ONLINE_API_KEY = 'bongnudo_online_api_key_v1';
    const ONLINE_LAST_SYNC_KEY = 'bongnudo_online_last_sync_v1';
    const ONLINE_BASELINE_KEY = 'bongnudo_online_baseline_v1';
    const ONLINE_SCHEMA_VERSION = 1;
    const SCRIPT_VERSION = '2.9.5';

    function seriesStorageKey(id) {
        return SERIES_DATA_PREFIX + id;
    }

    function validWatchData(value) {
        return !!value && typeof value === 'object' && Array.isArray(value.streamers);
    }

    function makeSeriesId() {
        return 'series_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    // 최초 업데이트 시 기존 봉누도 데이터는 새 기본 시리즈로 복사합니다.
    // 원래 키는 지우지 않아 문제가 생겨도 복구할 수 있습니다.
    let seriesMeta = GM_getValue(SERIES_META_KEY, null);
    if (!seriesMeta || typeof seriesMeta !== 'object' || !Array.isArray(seriesMeta.series) || !seriesMeta.series.length) {
        const legacyData = GM_getValue(LEGACY_STORAGE_KEY, null);
        const firstSeries = { id: 'bongnudo2', name: '봉누도 2' };
        seriesMeta = { series: [firstSeries], activeId: firstSeries.id };
        if (validWatchData(legacyData)) {
            GM_setValue(seriesStorageKey(firstSeries.id), legacyData);
        }
        GM_setValue(SERIES_META_KEY, seriesMeta);
    }
    seriesMeta.series = seriesMeta.series.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && item.name.trim());
    if (!seriesMeta.series.length) {
        seriesMeta.series = [{ id: 'bongnudo2', name: '봉누도 2' }];
    }
    if (!seriesMeta.series.some(item => item.id === seriesMeta.activeId)) {
        seriesMeta.activeId = seriesMeta.series[0].id;
    }
    let activeSeriesId = seriesMeta.activeId;
    let STORAGE_KEY = seriesStorageKey(activeSeriesId);
    if (!validWatchData(GM_getValue(STORAGE_KEY, null)) && activeSeriesId === 'bongnudo2') {
        const legacyData = GM_getValue(LEGACY_STORAGE_KEY, null);
        if (validWatchData(legacyData)) GM_setValue(STORAGE_KEY, legacyData);
    }

    const DEFAULT_SETTINGS = {
        opacity: 0.95,
        panelClosed: false,
        panelCollapsed: false,
        panelX: null,
        panelY: null,
        panelWidth: 430,
        panelHeight: 570,
        sortMode: 'recent',
        streamerViewMode: 'scroll',
        streamerPageIndex: 0,
        collapsedWidth: 150,
        collapsedHeight: 42
    };

    const MIN_WIDTH = 280;
    const MAX_WIDTH = 650;
    const MIN_HEIGHT = 220;

    const BASE_WIDTH = 430;

    /*
     * 저장 데이터를 먼저 검증합니다.
     * 잘못 읽힌 경우 빈 데이터로 기존 저장값을 덮어쓰지 않습니다.
     */
    const loadedData = GM_getValue(STORAGE_KEY, null);

    let storageValid = validWatchData(loadedData);

    let data = storageValid
        ? loadedData
        : {
            streamers: [],
            settings: { ...DEFAULT_SETTINGS }
        };

    let panel = null;
    let reopenButton = null;

    let currentEntry = null;

    // 완료된 영상의 펼침 상태는 화면에서만 관리합니다. 저장 데이터에는 영향을 주지 않습니다.
    const expandedCompletedEntries = new Set();
    let currentStreamer = null;
    let currentVideoId = null;

    let attachedVideo = null;
    let lastSavedPercent = -1;

    // 저장된 시청 위치 복구 팝업은 영상별로 한 번만 확인합니다.
    let resumePromptHandledFor = null;
    let resumePromptTimer = null;
    let manualSeekDetectedFor = null;
    let lastPlayerInteractionAt = 0;
    let lastUrl = location.href;

    let resizeObserver = null;

    let resizeState = null;

    /************************************************
     * 데이터 준비
     ************************************************/

    function prepareData() {

        if (!data || typeof data !== 'object') {
            data = {
                streamers: [],
                settings: { ...DEFAULT_SETTINGS }
            };
        }

        if (!Array.isArray(data.streamers)) {
            data.streamers = [];
        }

        if (!data.settings || typeof data.settings !== 'object') {
            data.settings = { ...DEFAULT_SETTINGS };
        }

        const s = data.settings;

        // 이전 기본 높이(600px)를 사용 중이었다면 새 기본 높이(570px)로 조정합니다.
        // 사용자가 직접 다른 높이로 설정한 값은 유지합니다.
        if (s.panelHeight === 600) {
            s.panelHeight = DEFAULT_SETTINGS.panelHeight;
        }

        if (
            typeof s.opacity !== 'number' ||
            !isFinite(s.opacity)
        ) {
            s.opacity = DEFAULT_SETTINGS.opacity;
        }

        s.opacity = Math.min(
            1,
            Math.max(0.2, s.opacity)
        );

        if (typeof s.panelClosed !== 'boolean') {
            s.panelClosed = false;
        }

        if (typeof s.panelCollapsed !== 'boolean') {
            s.panelCollapsed = false;
        }

        if (
            typeof s.panelWidth !== 'number' ||
            !isFinite(s.panelWidth)
        ) {
            s.panelWidth = DEFAULT_SETTINGS.panelWidth;
        }

        s.panelWidth = Math.min(
            MAX_WIDTH,
            Math.max(MIN_WIDTH, s.panelWidth)
        );

        if (
            typeof s.panelHeight !== 'number' ||
            !isFinite(s.panelHeight)
        ) {
            s.panelHeight = DEFAULT_SETTINGS.panelHeight;
        }

        s.panelHeight = Math.max(
            MIN_HEIGHT,
            s.panelHeight
        );

        s.sortMode = 'recent';
        if (!['scroll', 'page'].includes(s.streamerViewMode)) s.streamerViewMode = 'scroll';
        if (!Number.isInteger(s.streamerPageIndex) || s.streamerPageIndex < 0) s.streamerPageIndex = 0;

        if (typeof s.collapsedWidth !== 'number' || !isFinite(s.collapsedWidth)) {
            s.collapsedWidth = DEFAULT_SETTINGS.collapsedWidth;
        }

        if (typeof s.collapsedHeight !== 'number' || !isFinite(s.collapsedHeight)) {
            s.collapsedHeight = DEFAULT_SETTINGS.collapsedHeight;
        }

        s.collapsedWidth = Math.max(120, Math.min(220, s.collapsedWidth));
        s.collapsedHeight = Math.max(38, Math.min(60, s.collapsedHeight));

        data.streamers.forEach(streamer => {

            if (!Array.isArray(streamer.entries)) {
                streamer.entries = [];
            }

            if (typeof streamer.bulkAddChannelUrl !== 'string') {
                streamer.bulkAddChannelUrl = '';
            }

            if (typeof streamer.collapsed !== 'boolean') {
                streamer.collapsed = false;
            }

            // 스트리머별 영상 목록 높이: 사용자가 크기를 조절한 경우에만 저장합니다.
            if (typeof streamer.entriesHeight !== 'number' || !isFinite(streamer.entriesHeight)) {
                delete streamer.entriesHeight;
            } else {
                streamer.entriesHeight = Math.max(80, Math.min(1200, streamer.entriesHeight));
            }

            if (typeof streamer.lastPlayedAt !== 'number' || !isFinite(streamer.lastPlayedAt)) {
                streamer.lastPlayedAt = 0;
            }

            streamer.entries.forEach(entry => {

                /*
                 * 기존 데이터가 YouTube라면
                 * 삭제하지 않고 보존합니다.
                 *
                 * UI에서는 치지직만 표시합니다.
                 */

                if (typeof entry.completed !== 'boolean') {
                    entry.completed =
                        (entry.percent || 0) >= 100;
                }

                if (
                    typeof entry.watchedSeconds !== 'number'
                ) {
                    entry.watchedSeconds = 0;
                }

                if (
                    typeof entry.percent !== 'number'
                ) {
                    entry.percent = 0;
                }

                if (typeof entry.title !== 'string') {
                    entry.title = '';
                }
            });
        });
    }

    prepareData();

    /*
     * 여러 치지직 탭이 동시에 같은 저장 데이터를 사용할 때
     * 한 탭의 오래된 data 전체를 다른 탭의 최신 데이터 위에
     * 그대로 덮어쓰지 않도록 마지막 동기화 상태를 기억합니다.
     */
    function cloneData(value) {
        return JSON.parse(JSON.stringify(value));
    }

    let dataBaseline = cloneData(data);


    /************************************************
     * 다중 탭 데이터 병합
     ************************************************/

    function valuesEqual(a, b) {
        return JSON.stringify(a) === JSON.stringify(b);
    }

    function getStreamerKey(streamer) {
        return streamer && typeof streamer.name === 'string'
            ? streamer.name
            : '';
    }

    function getEntryKey(entry) {
        if (!entry || typeof entry !== 'object') {
            return '';
        }

        return String(
            entry.videoId ||
            entry.url ||
            ''
        );
    }

    function findMatchingItem(list, localItem, baseItem, keyGetter) {
        if (!Array.isArray(list)) {
            return null;
        }

        const localKey = keyGetter(localItem);
        if (localKey) {
            const byLocalKey = list.find(
                item => keyGetter(item) === localKey
            );

            if (byLocalKey) {
                return byLocalKey;
            }
        }

        const baseKey = keyGetter(baseItem);
        if (baseKey) {
            const byBaseKey = list.find(
                item => keyGetter(item) === baseKey
            );

            if (byBaseKey) {
                return byBaseKey;
            }
        }

        return null;
    }

    function mergeArrayThreeWay(latest, baseline, local, keyGetter) {
        const latestList = Array.isArray(latest)
            ? cloneData(latest)
            : [];

        const baseList = Array.isArray(baseline)
            ? baseline
            : [];

        const localList = Array.isArray(local)
            ? local
            : [];

        /*
         * 먼저 로컬에서 추가/수정된 항목을 최신 저장값에 반영합니다.
         */
        for (const localItem of localList) {

            const baseItem =
                baseList.find(
                    item =>
                        keyGetter(item) &&
                        keyGetter(item) === keyGetter(localItem)
                ) || null;

            let target =
                findMatchingItem(
                    latestList,
                    localItem,
                    baseItem,
                    keyGetter
                );

            /*
             * 새 항목:
             * 이 탭에서 추가된 것이라면 최신 데이터에도 없을 경우 추가합니다.
             */
            if (!baseItem) {
                if (!target) {
                    latestList.push(cloneData(localItem));
                }

                continue;
            }

            /*
             * 기존 항목:
             * 같은 항목에 대해 로컬에서 바뀐 필드만 최신 데이터에 반영합니다.
             */
            if (target) {
                const merged =
                    mergeObjectThreeWay(
                        target,
                        baseItem,
                        localItem
                    );

                Object.keys(target).forEach(key => {
                    delete target[key];
                });

                Object.assign(target, merged);
            }
        }

        /*
         * 로컬에서 삭제한 항목은,
         * 다른 탭에서 그 사이에 수정되지 않았을 때만 삭제합니다.
         *
         * 다른 탭에서 수정됐다면 해당 데이터를 보존합니다.
         */
        for (let i = latestList.length - 1; i >= 0; i--) {

            const latestItem = latestList[i];
            const key = keyGetter(latestItem);

            if (!key) {
                continue;
            }

            const baseItem =
                baseList.find(
                    item => keyGetter(item) === key
                );

            if (!baseItem) {
                continue;
            }

            const localItem =
                localList.find(
                    item => keyGetter(item) === key
                );

            if (localItem) {
                continue;
            }

            if (valuesEqual(latestItem, baseItem)) {
                latestList.splice(i, 1);
            }
        }

        return latestList;
    }

    function mergeObjectThreeWay(latest, baseline, local) {

        const result =
            latest &&
            typeof latest === 'object'
                ? cloneData(latest)
                : {};

        const base =
            baseline &&
            typeof baseline === 'object'
                ? baseline
                : {};

        const localValue =
            local &&
            typeof local === 'object'
                ? local
                : {};

        const keys = new Set([
            ...Object.keys(base),
            ...Object.keys(localValue),
            ...Object.keys(result)
        ]);

        for (const key of keys) {

            /*
             * 스트리머/영상 배열은 별도의 3-way 병합을 사용합니다.
             */
            if (
                key === 'streamers' &&
                Array.isArray(localValue[key])
            ) {

                result[key] =
                    mergeArrayThreeWay(
                        result[key],
                        base[key],
                        localValue[key],
                        getStreamerKey
                    );

                /*
                 * 스트리머 내부 entries까지 다시 병합합니다.
                 */
                for (const streamer of result[key]) {

                    const localStreamer =
                        localValue[key].find(
                            s =>
                                getStreamerKey(s) ===
                                getStreamerKey(streamer)
                        );

                    const baseStreamer =
                        base[key]?.find(
                            s =>
                                getStreamerKey(s) ===
                                getStreamerKey(streamer)
                        );

                    if (
                        localStreamer &&
                        baseStreamer &&
                        Array.isArray(localStreamer.entries)
                    ) {

                        streamer.entries =
                            mergeArrayThreeWay(
                                streamer.entries,
                                baseStreamer.entries,
                                localStreamer.entries,
                                getEntryKey
                            );
                    }
                }

                continue;
            }

            const baseHas = Object.prototype.hasOwnProperty.call(
                base,
                key
            );

            const localHas = Object.prototype.hasOwnProperty.call(
                localValue,
                key
            );

            const latestHas = Object.prototype.hasOwnProperty.call(
                result,
                key
            );

            if (!localHas) {
                /*
                 * 로컬에서 삭제했지만 최신 탭에서 바뀌지 않았다면 삭제.
                 * 최신 탭에서 바뀌었다면 보존.
                 */
                if (
                    baseHas &&
                    latestHas &&
                    valuesEqual(result[key], base[key])
                ) {
                    delete result[key];
                }

                continue;
            }

            /*
             * 로컬 값이 baseline과 같다면 이 탭에서는 바꾸지 않은 것이므로
             * 최신 탭의 값을 그대로 유지합니다.
             */
            if (
                baseHas &&
                valuesEqual(localValue[key], base[key])
            ) {
                continue;
            }

            /*
             * 객체/배열이면서 로컬에서 변경됐다면 재귀적으로 병합합니다.
             */
            if (
                localValue[key] &&
                typeof localValue[key] === 'object' &&
                !Array.isArray(localValue[key]) &&
                result[key] &&
                typeof result[key] === 'object' &&
                !Array.isArray(result[key])
            ) {

                result[key] =
                    mergeObjectThreeWay(
                        result[key],
                        baseHas ? base[key] : {},
                        localValue[key]
                    );

                continue;
            }

            /*
             * 이 탭에서 실제로 변경한 값만 최신 저장값에 반영합니다.
             */
            result[key] = cloneData(localValue[key]);
        }

        return result;
    }


    /************************************************
     * 저장
     ************************************************/

    function saveData() {

        /*
         * 여러 치지직 탭이 동시에 같은 저장소를 사용합니다.
         *
         * 중요:
         * 이전 2.3.4처럼 saveData()에서 data 객체 자체를
         * 병합 결과로 교체하지 않습니다.
         *
         * 현재 탭의 data에서 실제 변경된 부분만 최신 저장값에
         * 반영한 뒤 저장합니다.
         */

        const latestStored =
            GM_getValue(STORAGE_KEY, null);

        if (
            !latestStored ||
            typeof latestStored !== 'object' ||
            !Array.isArray(latestStored.streamers)
        ) {
            if (
                !storageValid &&
                data.streamers.length === 0
            ) {
                console.warn(
                    '[봉누도] 저장 데이터가 유효하지 않아 저장을 중단했습니다.'
                );
                return false;
            }

            GM_setValue(STORAGE_KEY, data);
            storageValid = true;
            dataBaseline = cloneData(data);
            return true;
        }

        const latest = cloneData(latestStored);
        const baseline =
            dataBaseline &&
            Array.isArray(dataBaseline.streamers)
                ? dataBaseline
                : { streamers: [] };

        /*
         * 최신 저장 데이터를 기본으로 사용합니다.
         * 따라서 다른 탭에서 새로 추가한 스트리머/영상은
         * 이 탭의 오래된 data 때문에 사라지지 않습니다.
         */
        const merged = latest;

        /*
         * 스트리머 추가/수정/삭제 및 내부 영상 변경을 병합합니다.
         */
        const localStreamers =
            Array.isArray(data.streamers)
                ? data.streamers
                : [];

        const baseStreamers =
            Array.isArray(baseline.streamers)
                ? baseline.streamers
                : [];

        for (const localStreamer of localStreamers) {

            const name =
                getStreamerKey(localStreamer);

            if (!name) {
                continue;
            }

            const baseStreamer =
                baseStreamers.find(
                    s => getStreamerKey(s) === name
                );

            const latestStreamer =
                merged.streamers.find(
                    s => getStreamerKey(s) === name
                );

            /*
             * baseline에는 없는데 현재 탭에 존재한다면
             * 이 탭에서 새로 추가한 스트리머입니다.
             */
            if (!baseStreamer) {

                if (!latestStreamer) {
                    merged.streamers.push(
                        cloneData(localStreamer)
                    );
                }

                continue;
            }

            if (!latestStreamer) {
                /*
                 * 이 탭에서 삭제했지만 다른 탭에서도 이미 삭제된
                 * 경우이므로 아무것도 하지 않습니다.
                 */
                continue;
            }

            /*
             * 스트리머 자체의 필드 중 이 탭에서 변경된 값만 반영합니다.
             */
            for (const key of Object.keys(localStreamer)) {

                if (key === 'entries') {
                    continue;
                }

                const baseValue =
                    baseStreamer[key];

                const localValue =
                    localStreamer[key];

                if (
                    !valuesEqual(
                        localValue,
                        baseValue
                    )
                ) {
                    latestStreamer[key] =
                        cloneData(localValue);
                }
            }

            /*
             * 영상 목록 병합
             */
            const localEntries =
                Array.isArray(localStreamer.entries)
                    ? localStreamer.entries
                    : [];

            const baseEntries =
                Array.isArray(baseStreamer.entries)
                    ? baseStreamer.entries
                    : [];

            if (!Array.isArray(latestStreamer.entries)) {
                latestStreamer.entries = [];
            }

            for (const localEntry of localEntries) {

                const entryKey =
                    getEntryKey(localEntry);

                if (!entryKey) {
                    continue;
                }

                const baseEntry =
                    baseEntries.find(
                        e =>
                            getEntryKey(e) ===
                            entryKey
                    );

                const latestEntry =
                    latestStreamer.entries.find(
                        e =>
                            getEntryKey(e) ===
                            entryKey
                    );

                /*
                 * baseline에 없으면 이 탭에서 새로 추가한 영상입니다.
                 */
                if (!baseEntry) {

                    if (!latestEntry) {
                        latestStreamer.entries.push(
                            cloneData(localEntry)
                        );
                    }

                    continue;
                }

                if (!latestEntry) {
                    continue;
                }

                /*
                 * 기존 영상은 이 탭에서 실제로 변경된 필드만
                 * 최신 저장값에 반영합니다.
                 *
                 * 예:
                 * 1번 탭의 watchedSeconds/percent 변경
                 * 2번 탭의 day/url 변경
                 * 서로 덮어쓰지 않습니다.
                 */
                for (const key of Object.keys(localEntry)) {

                    const baseValue =
                        baseEntry[key];

                    const localValue =
                        localEntry[key];

                    if (
                        !valuesEqual(
                            localValue,
                            baseValue
                        )
                    ) {
                        latestEntry[key] =
                            cloneData(localValue);
                    }
                }
            }
        }

        /*
         * 스트리머 삭제 반영
         *
         * 기존 saveData()는 현재 탭에 "존재하는" 스트리머만 병합했기 때문에
         * 이 탭에서 스트리머를 삭제하면 latest 데이터에 그대로 남았습니다.
         *
         * baseline에 있었지만 현재 data에서 사라진 스트리머는
         * 이 탭에서 명시적으로 삭제한 것으로 보고 latest에서도 제거합니다.
         * baseline에 없던 다른 탭의 신규 스트리머는 건드리지 않습니다.
         */
        for (const baseStreamer of baseStreamers) {

            const baseKey =
                getStreamerKey(baseStreamer);

            if (!baseKey) {
                continue;
            }

            const stillExistsLocally =
                localStreamers.some(
                    s => getStreamerKey(s) === baseKey
                );

            if (stillExistsLocally) {
                continue;
            }

            const deleteIndex =
                merged.streamers.findIndex(
                    s => getStreamerKey(s) === baseKey
                );

            if (deleteIndex !== -1) {
                merged.streamers.splice(
                    deleteIndex,
                    1
                );
            }
        }

        /*
         * 스트리머 이름을 수정한 경우에도 기존 이름의 스트리머가
         * 저장소에 남지 않도록 위 삭제 처리에서 함께 정리됩니다.
         */

        /*
         * 현재 탭에서 새로 추가한 설정값도 반영합니다.
         * 패널 위치/크기/정렬/접기 등의 설정 충돌을 최소화하기 위해
         * baseline과 달라진 값만 저장합니다.
         */
        if (
            data.settings &&
            latest.settings
        ) {
            const baseSettings =
                baseline.settings || {};

            for (
                const key of Object.keys(data.settings)
            ) {
                if (
                    !valuesEqual(
                        data.settings[key],
                        baseSettings[key]
                    )
                ) {
                    latest.settings[key] =
                        cloneData(data.settings[key]);
                }
            }
        }

        /*
         * 병합된 결과를 저장합니다.
         */
        GM_setValue(
            STORAGE_KEY,
            merged
        );

        storageValid = true;

        /*
         * 다음 저장의 기준점은 이번에 실제 저장한 결과입니다.
         */
        dataBaseline =
            cloneData(merged);

        /*
         * 현재 탭의 data 객체는 기존 참조를 유지합니다.
         * 단, 다른 탭에서 추가된 데이터도 다음 UI 갱신 때
         * 저장소에서 다시 읽을 수 있도록 합니다.
         */
        return true;
    }


    /************************************************
     * HTML escape
     ************************************************/

    function escapeHtml(value) {

        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }


    /************************************************
     * 치지직 URL
     ************************************************/

    function normalizeUrl(url) {

        try {

            const u = new URL(url);

            u.hash = '';

            return u.toString().replace(/\/$/, '');

        } catch (e) {

            return String(url).trim();
        }
    }



    /************************************************
     * 치지직 영상 업로드 날짜 조회
     ************************************************/

    function getChzzkVideoNo(entry) {

        const match =
            String(entry.url || '').match(
                /\/video\/(\d+)/i
            );

        return match
            ? match[1]
            : null;
    }


    function formatChzzkPublishDate(value) {

        if (!value) {
            return '';
        }

        const match =
            String(value).match(
                /^(\d{4})-(\d{1,2})-(\d{1,2})/
            );

        if (!match) {
            return '';
        }

        return (
            Number(match[2]) +
            '/' +
            Number(match[3])
        );
    }


    function fetchChzzkPublishDate(
        entry,
        callback
    ) {

        if (entry.publishedDate) {

            callback(
                String(entry.publishedDate)
            );

            return;
        }

        const videoNo =
            getChzzkVideoNo(entry);

        if (!videoNo) {
            callback('');
            return;
        }

        GM_xmlhttpRequest({

            method: 'GET',

            url:
                'https://api.chzzk.naver.com/service/v2/videos/' +
                encodeURIComponent(videoNo),

            timeout: 8000,

            onload: function (response) {

                try {

                    const result =
                        JSON.parse(
                            response.responseText
                        );

                    const publishDate =
                        result &&
                        result.content &&
                        result.content.publishDate;

                    const formatted =
                        formatChzzkPublishDate(
                            publishDate
                        );

                    if (formatted) {

                        entry.publishedDate =
                            formatted;

                        saveData();
                    }

                    callback(formatted);

                } catch (error) {

                    callback('');
                }
            },

            onerror: function () {
                callback('');
            },

            ontimeout: function () {
                callback('');
            }
        });
    }


    /************************************************
     * 현재 치지직 페이지
     ************************************************/

    function getCurrentVideoId() {

        if (
            !location.hostname
                .toLowerCase()
                .includes('chzzk.naver.com')
        ) {
            return null;
        }

        return normalizeUrl(location.href);
    }


    /************************************************
     * 현재 영상 찾기
     ************************************************/

    function findCurrentEntry() {

        const id = getCurrentVideoId();

        if (currentVideoId !== id) {
            if (resumePromptTimer) {
                clearTimeout(resumePromptTimer);
                resumePromptTimer = null;
            }
            resumePromptHandledFor = null;
            manualSeekDetectedFor = null;
        }
        currentVideoId = id;
        currentEntry = null;
        currentStreamer = null;

        if (!id) {
            return null;
        }

        for (const streamer of data.streamers) {

            for (const entry of streamer.entries) {

                if (
                    entry.type === 'chzzk' &&
                    entry.videoId === id
                ) {

                    currentStreamer = streamer;
                    currentEntry = entry;

                    return {
                        streamer,
                        entry
                    };
                }
            }
        }

        return null;
    }


    /************************************************
     * 비디오 요소
     ************************************************/

    function getVideoElement() {

        return (
            document.querySelector(
                'video.html5-main-video'
            ) ||
            document.querySelector('video')
        );
    }


    /************************************************
     * 시청률 계산
     ************************************************/

    function calculatePercent(video) {

        if (
            !video ||
            !video.duration ||
            !isFinite(video.duration)
        ) {
            return 0;
        }

        if (
            video.currentTime >=
            video.duration - 1
        ) {
            return 100;
        }

        return Math.min(
            100,
            Math.max(
                0,
                Math.floor(
                    (
                        video.currentTime /
                        video.duration
                    ) * 100
                )
            )
        );
    }


    /************************************************
     * 시청 기록
     ************************************************/

    function updateWatchProgress() {

        if (!currentEntry) {
            findCurrentEntry();
        }

        if (!currentEntry) {
            return;
        }

        if (currentEntry.completed) {
            return;
        }

        const video = getVideoElement();

        if (!video) {
            return;
        }

        if (
            !video.duration ||
            !isFinite(video.duration)
        ) {
            return;
        }

        const currentTime =
            video.currentTime || 0;

        currentEntry.lastPlayedAt = Date.now();
        if (currentStreamer) currentStreamer.lastPlayedAt = currentEntry.lastPlayedAt;

        const previousTime =
            currentEntry.watchedSeconds || 0;

        /*
         * 최대 시청 위치만 저장
         */
        if (currentTime > previousTime) {

            currentEntry.watchedSeconds =
                currentTime;
        }

        let percent = calculatePercent(video);

        /*
         * 영상 마지막 부분
         */
        if (
            currentTime >=
            video.duration - 1
        ) {

            percent = 100;

            currentEntry.watchedSeconds =
                video.duration;
        }

        /*
         * 이전보다 낮아지지 않도록 함
         */
        if (
            percent >
            (currentEntry.percent || 0)
        ) {

            currentEntry.percent =
                Math.min(100, percent);
        }

        /*
         * 100% 자동 완료
         */
        if (
            currentEntry.percent >= 100
        ) {

            currentEntry.percent = 100;
            if (!currentEntry.completed) {
                expandedCompletedEntries.delete(getEntryDomId(currentEntry));
            }
            currentEntry.completed = true;
        }

        if (
            currentEntry.percent !==
            lastSavedPercent
        ) {

            lastSavedPercent =
                currentEntry.percent;

            if (currentStreamer) {
                currentStreamer.lastPlayedAt = Date.now();
            }

            saveData();

            updateCurrentVideo();
            if (currentEntry.completed) {
                updatePanel();
            } else {
                updateEntryProgressInPanel();
            }
        }
    }


    /************************************************
     * 저장된 시청 위치 복구
     ************************************************/

    function scheduleResumePositionCheck(video) {

        if (!video || !currentEntry || !currentVideoId) return;

        const videoId = currentVideoId;
        const savedPosition = Number(currentEntry.watchedSeconds) || 0;

        // 의미 있는 시청 기록이 있고, 영상이 아직 첫 1분 안에 있을 때만 검토합니다.
        if (savedPosition < 30 || video.currentTime > 60) return;
        if (resumePromptHandledFor === videoId) return;
        if (manualSeekDetectedFor === videoId) return;
        if (!video.duration || !isFinite(video.duration)) return;
        if (savedPosition >= video.duration - 5) return;

        // timeupdate는 자주 발생하므로 예약된 타이머가 있으면 그대로 둡니다.
        if (resumePromptTimer) return;
        resumePromptTimer = setTimeout(() => {
            resumePromptTimer = null;

            // 기다리는 동안 영상/기록이 바뀌었거나 사용자가 탐색했다면 팝업을 띄우지 않습니다.
            if (getCurrentVideoId() !== videoId || getVideoElement() !== video) return;
            if (!currentEntry || currentVideoId !== videoId) return;
            if (resumePromptHandledFor === videoId || manualSeekDetectedFor === videoId) return;
            if (video.currentTime > 60 || video.currentTime < 0) return;
            if (video.paused && video.readyState < 2) return;

            const latestSavedPosition = Number(currentEntry.watchedSeconds) || 0;
            if (latestSavedPosition < 30 || latestSavedPosition >= video.duration - 5) return;

            // 팝업을 닫거나 거절해도 같은 영상에서 반복해서 나타나지 않게 먼저 처리합니다.
            resumePromptHandledFor = videoId;
            const formatTime = seconds => {
                const value = Math.floor(Math.max(0, seconds));
                const hours = Math.floor(value / 3600);
                const minutes = Math.floor((value % 3600) / 60);
                const secs = value % 60;
                return hours > 0
                    ? `${hours}시간 ${minutes}분 ${secs}초`
                    : `${minutes}분 ${secs}초`;
            };

            const shouldRestore = window.confirm(
                `이 영상의 저장된 시청 위치가 있습니다.\n\n` +
                `저장된 위치: ${formatTime(latestSavedPosition)}\n` +
                `현재 위치: ${formatTime(video.currentTime)}\n\n` +
                `저장된 위치부터 이어서 재생할까요?`
            );

            if (shouldRestore && getCurrentVideoId() === videoId && getVideoElement() === video) {
                try {
                    video.currentTime = Math.min(latestSavedPosition, Math.max(0, video.duration - 1));
                } catch (error) {
                    console.warn('[시청 기록] 저장된 위치로 이동하지 못했습니다.', error);
                }
            }
        }, 1800);
    }


    /************************************************
     * 비디오 이벤트
     ************************************************/

    function attachVideoEvents(video) {

        if (!video) {
            return;
        }

        if (attachedVideo === video) {
            return;
        }

        attachedVideo = video;

        video.addEventListener(
            'timeupdate',
            updateWatchProgress
        );

        video.addEventListener(
            'ended',
            updateWatchProgress
        );

        video.addEventListener(
            'loadedmetadata',
            updateWatchProgress
        );

        video.addEventListener(
            'durationchange',
            updateWatchProgress
        );

        video.addEventListener(
            'seeked',
            updateWatchProgress
        );

        // 플레이어 조작 직후 발생한 seeking만 사용자의 직접 탐색으로 판단합니다.
        // 영상 초기화 과정에서 플레이어가 자동으로 seek 이벤트를 발생시키는 경우에는
        // 복구 팝업이 잘못 억제되지 않도록 합니다.
        const playerInteractionRoot =
            video.closest('.pzp-pc, .pzp, [class*="player"], [class*="Player"]') ||
            video.parentElement;

        if (playerInteractionRoot) {
            const markPlayerInteraction = event => {
                if (event.type !== 'keydown' ||
                    ['ArrowLeft', 'ArrowRight', 'Home', 'End', ' '].includes(event.key)) {
                    lastPlayerInteractionAt = Date.now();
                }
            };
            playerInteractionRoot.addEventListener('pointerdown', markPlayerInteraction, true);
            playerInteractionRoot.addEventListener('mousedown', markPlayerInteraction, true);
            playerInteractionRoot.addEventListener('touchstart', markPlayerInteraction, true);
            playerInteractionRoot.addEventListener('keydown', markPlayerInteraction, true);
        }

        // 사용자가 직접 다른 구간으로 이동하면 복구 팝업을 억제합니다.
        // 초기 자동 seek와 달리 플레이어를 직접 조작한 직후의 탐색만 기록합니다.
        video.addEventListener('seeking', () => {
            const recentPlayerInteraction = Date.now() - lastPlayerInteractionAt < 1800;
            const clearlyPastFirstMinute = video.currentTime > 60;
            if (currentVideoId && (recentPlayerInteraction || clearlyPastFirstMinute)) {
                manualSeekDetectedFor = currentVideoId;
                if (resumePromptTimer) {
                    clearTimeout(resumePromptTimer);
                    resumePromptTimer = null;
                }
            }
        });

        const checkResume = () => scheduleResumePositionCheck(video);
        video.addEventListener('loadedmetadata', checkResume);
        video.addEventListener('durationchange', checkResume);
        video.addEventListener('playing', checkResume);
        video.addEventListener('timeupdate', checkResume);
    }


    /************************************************
     * 수동 완료
     ************************************************/

    function completeEntry(entry) {

        expandedCompletedEntries.delete(getEntryDomId(entry));
        entry.completed = true;
        entry.percent = 100;

        const video = getVideoElement();

        if (
            video &&
            video.duration &&
            isFinite(video.duration)
        ) {

            entry.watchedSeconds =
                video.duration;
        }

        saveData();
        updatePanel();
    }


    /************************************************
     * 완료 취소
     ************************************************/

    function undoCompleteEntry(entry) {

        expandedCompletedEntries.delete(getEntryDomId(entry));
        entry.completed = false;

        saveData();
        updatePanel();
    }


    /************************************************
     * 기록 초기화
     ************************************************/

    function resetEntry(entry) {

        const ok = confirm(
            `${entry.day} 시청 기록을 초기화할까요?`
        );

        if (!ok) {
            return;
        }

        entry.watchedSeconds = 0;
        entry.percent = 0;
        entry.completed = false;

        saveData();
        updatePanel();
    }


    /************************************************
     * 스트리머 추가
     ************************************************/

    function addStreamer() {

        const name = prompt(
            '스트리머 이름을 입력하세요.'
        );

        if (!name) {
            return;
        }

        const trimmed = name.trim();

        if (!trimmed) {
            return;
        }

        if (
            data.streamers.some(
                s => s.name === trimmed
            )
        ) {

            alert(
                '이미 등록된 스트리머입니다.'
            );

            return;
        }

        data.streamers.push({

            name: trimmed,

            entries: [],

            collapsed: false

        });

        saveData();
        updatePanel();
    }


    /************************************************
     * 스트리머 이름 수정
     ************************************************/

    function editStreamerName(streamer) {

        const name = prompt(
            '새 스트리머 이름을 입력하세요.',
            streamer.name
        );

        if (name === null) {
            return;
        }

        const trimmed = name.trim();

        if (!trimmed) {
            return;
        }

        streamer.name = trimmed;

        saveData();
        updatePanel();
    }


    /************************************************
     * 스트리머 삭제
     ************************************************/

    function deleteStreamer(streamer) {

        const ok = confirm(
            `"${streamer.name}" 스트리머와\n` +
            `등록된 모든 영상을 삭제할까요?`
        );

        if (!ok) {
            return;
        }

        data.streamers =
            data.streamers.filter(
                s => s !== streamer
            );

        saveData();
        updatePanel();
    }


    /************************************************
     * 영상 추가
     ************************************************/

    function addEntry(streamer) {

        const day = prompt(
            `${streamer.name}에 추가할 일차를 입력하세요.\n\n` +
            `예: 1일차`
        );

        if (!day) {
            return;
        }

        const title = prompt(
            `${streamer.name} ${day}\n\n` +
            `영상 제목을 입력하세요.\n` +
            `예: 봉누도 1일차 생존기`,
            ''
        );

        if (title === null) {
            return;
        }

        const link = prompt(
            `${streamer.name} ${day} ${title.trim()}\n\n` +
            `치지직 다시보기 링크를 입력하세요.`
        );

        if (!link) {
            return;
        }

        const trimmedUrl =
            link.trim();

        if (
            !trimmedUrl.includes(
                'chzzk.naver.com'
            )
        ) {

            alert(
                '치지직 링크만 등록할 수 있습니다.'
            );

            return;
        }

        const id =
            normalizeUrl(trimmedUrl);

        if (
            streamer.entries.some(
                e =>
                    e.type === 'chzzk' &&
                    e.videoId === id
            )
        ) {

            alert(
                '이미 등록된 링크입니다.'
            );

            return;
        }

        streamer.entries.push({

            day: day.trim(),

            title: title.trim(),

            url: trimmedUrl,

            type: 'chzzk',

            videoId: id,

            watchedSeconds: 0,

            percent: 0,

            completed: false

        });

        saveData();
        updatePanel();
    }


    /************************************************
     * 영상 수정
     ************************************************/

    function editEntry(streamer, entry) {

        const day = prompt(
            '일차를 수정하세요.',
            entry.day
        );

        if (day === null) {
            return;
        }

        const trimmedDay = day.trim();

        if (!trimmedDay) {
            return;
        }

        const title = prompt(
            '영상 제목을 수정하세요.',
            entry.title || ''
        );

        if (title === null) {
            return;
        }

        const url = prompt(
            '치지직 영상 링크를 수정하세요.',
            entry.url
        );

        if (url === null) {
            return;
        }

        const trimmedUrl =
            url.trim();

        if (
            !trimmedUrl.includes(
                'chzzk.naver.com'
            )
        ) {

            alert(
                '치지직 링크만 사용할 수 있습니다.'
            );

            return;
        }

        entry.day = trimmedDay;
        entry.title = title.trim();
        entry.url = trimmedUrl;
        entry.videoId =
            normalizeUrl(trimmedUrl);

        saveData();
        updatePanel();
    }


    /************************************************
     * 영상 삭제
     ************************************************/

    function deleteEntry(
        streamer,
        entry
    ) {

        const ok = confirm(
            `${streamer.name} ${entry.day}\n\n` +
            `이 영상을 삭제할까요?`
        );

        if (!ok) {
            return;
        }

        streamer.entries =
            streamer.entries.filter(
                e => e !== entry
            );

        saveData();
        updatePanel();
    }


    /************************************************
     * 영상 열기
     ************************************************/

    function openEntry(entry) {

        window.location.href =
            entry.url;
    }


    /************************************************
     * 일차 숫자
     ************************************************/

    function getDayNumber(day) {

        const match =
            String(day).match(/\d+(?:\.\d+)?/);

        return match
            ? parseFloat(match[0])
            : 999999;
    }


    /************************************************
     * 현재 영상 표시
     ************************************************/

    function getOrderedEntries(streamer) {
        return (streamer?.entries || [])
            .filter(entry => entry.type === 'chzzk' && entry.url)
            .slice()
            .sort((a, b) => {
                const dayDiff = getDayNumber(a.day) - getDayNumber(b.day);
                if (dayDiff !== 0) return dayDiff;
                return String(a.day || '').localeCompare(String(b.day || ''), undefined, { numeric: true });
            });
    }

    function getLastWatchedEntry() {
        const all = [];
        for (const streamer of data.streamers || []) {
            for (const entry of streamer.entries || []) {
                if (entry.type !== 'chzzk' || !entry.url) continue;
                all.push({ streamer, entry, time: Number(entry.lastPlayedAt || 0) });
            }
        }
        all.sort((a, b) => b.time - a.time);
        if (all.length && all[0].time > 0) return all[0];

        // 기존 기록에는 영상별 시각이 없을 수 있으므로 스트리머의 마지막 재생 시각을 보조 기준으로 사용
        all.sort((a, b) => Number(b.streamer.lastPlayedAt || 0) - Number(a.streamer.lastPlayedAt || 0));
        return all[0] || null;
    }

    function updateCurrentVideo() {
        const current = document.getElementById('bn-current');
        if (!current) return;

        const result = findCurrentEntry();
        if (!result) {
            const last = getLastWatchedEntry();
            current.innerHTML = `
                <div class="bn-current-title">현재 페이지</div>
                <div class="bn-current-none">등록된 영상이 재생 중이 아닙니다.</div>
                ${last ? `
                    <div class="bn-last-watched">
                        <div class="bn-last-label">마지막 시청 영상</div>
                        <div class="bn-current-name">${escapeHtml(last.streamer.name)} - ${escapeHtml(last.entry.day)}</div>
                        <div class="bn-last-actions">
                            <button type="button" class="bn-current-control bn-resume">이어서 보기</button>
                        </div>
                    </div>` : '<div class="bn-current-none">저장된 시청 기록이 없습니다.</div>'}
            `;
            const resume = current.querySelector('.bn-resume');
            if (resume) resume.addEventListener('click', () => openEntry(last.entry));
            return;
        }

        const { streamer, entry } = result;
        const percent = Math.min(100, Math.max(0, Number(entry.percent) || 0));
        const ordered = getOrderedEntries(streamer);
        const index = ordered.findIndex(item => item === entry || (item.videoId && item.videoId === entry.videoId) || normalizeUrl(item.url) === normalizeUrl(entry.url));
        const previous = index > 0 ? ordered[index - 1] : null;
        const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;
        const video = getVideoElement();
        const pauseLabel = video && !video.paused ? '일시정지' : '재생';

        current.innerHTML = `
            <div class="bn-current-name">${escapeHtml(streamer.name)} - ${escapeHtml(entry.day)}</div>
            <div class="bn-current-controls">
                <button type="button" class="bn-current-control bn-previous ${previous ? '' : 'bn-boundary-disabled'}" aria-label="이전 영상" title="이전 영상" ${previous ? '' : 'data-boundary="previous"'}>‹</button>
                <button type="button" class="bn-current-control bn-pause" aria-label="${pauseLabel}" title="${pauseLabel}">${video && !video.paused ? '⏸︎' : '▶'}</button>
                <button type="button" class="bn-current-control bn-next ${next ? '' : 'bn-boundary-disabled'}" aria-label="다음 영상" title="다음 영상" ${next ? '' : 'data-boundary="next"'}>›</button>
            </div>
            <div class="bn-progress"><div class="bn-progress-bar" style="width:${percent}%"></div></div>
        `;
        const prevButton = current.querySelector('.bn-previous');
        const nextButton = current.querySelector('.bn-next');
        const pauseButton = current.querySelector('.bn-pause');
        if (previous) {
            prevButton.addEventListener('click', () => openEntry(previous));
        } else {
            prevButton.addEventListener('click', () => alert('이전 영상이 없습니다.'));
        }
        if (next) {
            nextButton.addEventListener('click', () => openEntry(next));
        } else {
            nextButton.addEventListener('click', () => alert('다음 영상이 없습니다.'));
        }
        pauseButton.addEventListener('click', () => {
            const activeVideo = getVideoElement();
            if (!activeVideo) {
                pauseButton.textContent = '×';
                pauseButton.title = '플레이어를 찾을 수 없습니다';
                pauseButton.disabled = true;
                return;
            }
            if (activeVideo.paused) {
                const playPromise = activeVideo.play();
                if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {});
            } else {
                activeVideo.pause();
            }
            setTimeout(updateCurrentVideo, 100);
        });
    }

    /************************************************
     * 패널 생성
     ************************************************/

    function getActiveSeriesName() {
        const found = seriesMeta.series.find(item => item.id === activeSeriesId);
        return found ? found.name : '시청 기록';
    }

    function persistSeriesMeta() {
        seriesMeta.activeId = activeSeriesId;
        GM_setValue(SERIES_META_KEY, seriesMeta);
    }

    function openSeriesManager() {
        const old = document.getElementById('bn-series-modal');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'bn-series-modal';
        overlay.innerHTML = `
            <div class="bn-series-dialog" role="dialog" aria-modal="true" aria-label="시리즈 선택">
                <div class="bn-series-heading"><strong>시리즈 선택</strong><button type="button" id="bn-series-close" title="닫기">×</button></div>
                <div class="bn-series-description">시리즈마다 스트리머와 시청 기록이 별도로 저장됩니다.</div>
                <div id="bn-series-list"></div>
                <div class="bn-series-actions"><button type="button" id="bn-series-add">＋ 새 시리즈 추가</button></div>
            </div>`;
        document.body.appendChild(overlay);

        const list = overlay.querySelector('#bn-series-list');
        for (const item of seriesMeta.series) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'bn-series-option' + (item.id === activeSeriesId ? ' active' : '');
            row.innerHTML = `<span class="bn-series-option-name">${escapeHtml(item.name)}</span><span class="bn-series-option-status">${item.id === activeSeriesId ? '현재 선택됨' : '선택'}</span>`;
            row.addEventListener('click', () => {
                if (item.id !== activeSeriesId) switchSeries(item.id);
                overlay.remove();
            });
            list.appendChild(row);
        }

        overlay.querySelector('#bn-series-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });
        overlay.querySelector('#bn-series-add').addEventListener('click', () => {
            const entered = prompt('새 시리즈 이름을 입력해주세요.');
            if (entered === null) return;
            const name = entered.trim();
            if (!name) { alert('시리즈 이름을 입력해주세요.'); return; }
            if (seriesMeta.series.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
                alert('같은 이름의 시리즈가 이미 있습니다.');
                return;
            }
            const item = { id: makeSeriesId(), name };
            seriesMeta.series.push(item);
            GM_setValue(seriesStorageKey(item.id), { streamers: [], settings: { ...DEFAULT_SETTINGS } });
            persistSeriesMeta();
            switchSeries(item.id);
            overlay.remove();
        });
    }

    function switchSeries(nextId) {
        if (!seriesMeta.series.some(item => item.id === nextId)) return;
        if (nextId === activeSeriesId) return;

        // 전환 전에 현재 시리즈의 최신 변경 사항을 저장합니다.
        savePanelSize();

        activeSeriesId = nextId;
        STORAGE_KEY = seriesStorageKey(activeSeriesId);
        persistSeriesMeta();

        const loaded = GM_getValue(STORAGE_KEY, null);
        storageValid = validWatchData(loaded);
        data = storageValid ? loaded : { streamers: [], settings: { ...DEFAULT_SETTINGS } };
        prepareData();
        dataBaseline = cloneData(data);

        currentEntry = null;
        currentStreamer = null;
        currentVideoId = null;
        lastSavedPercent = -1;
        attachedVideo = null;
        expandedCompletedEntries.clear();

        applyPanelSize();
        applyPanelPosition();
        applyOpacity();
        findCurrentEntry();
        attachVideoEvents(getVideoElement());
        updatePanel();
    }

    function createPanel() {

        if (panel) {
            return;
        }

        panel =
            document.createElement('div');

        panel.id =
            'bongnudo-watch-panel';

        panel.innerHTML = `

            <div class="bn-resize-handle bn-resize-left"></div>
            <div class="bn-resize-handle bn-resize-right"></div>
            <div class="bn-resize-handle bn-resize-top"></div>
            <div class="bn-resize-handle bn-resize-bottom"></div>

            <div class="bn-resize-corner bn-corner-tl"></div>
            <div class="bn-resize-corner bn-corner-tr"></div>
            <div class="bn-resize-corner bn-corner-bl"></div>
            <div class="bn-resize-corner bn-corner-br"></div>

            <div id="bn-header">

                <span id="bn-drag-handle">
                    <span id="bn-title-text">${escapeHtml(getActiveSeriesName())} 시청 기록</span>
                    <span id="bn-version-label">V${SCRIPT_VERSION}</span>
                </span>

                <div class="bn-header-buttons">

                    <button
                        id="bn-settings-button"
                        title="가져오기 / 내보내기">
                        ⚙
                    </button>

                    <button
                        id="bn-series-button"
                        title="시리즈 선택 / 추가">
                        ▤
                    </button>

                    <button
                        id="bn-collapse"
                        title="패널 접기">
                        −
                    </button>

                    <button
                        id="bn-close"
                        title="닫기">
                        ×
                    </button>

                </div>

            </div>

            <div id="bn-view-mode-bar" class="bn-view-mode-bar">
                <span>스트리머 표시</span>
                <select id="bn-view-mode">
                    <option value="scroll">스크롤 방식</option>
                    <option value="page">페이지 방식</option>
                </select>
            </div>

            <div id="bn-settings-panel" class="bn-hidden">

                <div id="bn-opacity-panel">
                    <span>투명도</span>
                    <input
                        id="bn-opacity-slider"
                        type="range"
                        min="0.2"
                        max="1"
                        step="0.05"
                        value="${data.settings.opacity}">
                    <span id="bn-opacity-value">
                        ${Math.round(data.settings.opacity * 100)}%
                    </span>
                </div>

                <div class="bn-data-row">
                    <button id="bn-export">내보내기</button>
                    <button id="bn-import">가져오기</button>
                </div>

                <div class="bn-data-row bn-online-row">
                    <button id="bn-online-config">온라인 연결 설정</button>
                    <button id="bn-online-sync">온라인 동기화</button>
                </div>
                <div id="bn-online-status" class="bn-online-status">온라인 저장소 미설정</div>

                <input
                    id="bn-import-file"
                    type="file"
                    accept=".txt,.json"
                    style="display:none">

            </div>

            <div id="bn-body">

                <div id="bn-current"></div>

                <div id="bn-streamers"></div>

                <div id="bn-buttons">

                    <button id="bn-add-streamer">
                        ＋ 스트리머 추가
                    </button>

                    <button id="bn-refresh">
                        새로고침
                    </button>

                </div>

            </div>
        `;

        panel.querySelector('#bn-version-label')?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            checkLatestScriptVersion(true);
        });

        document.body.appendChild(panel);

        applyPanelSize();
        applyPanelPosition();
        applyOpacity();

        // 초기 렌더링이 끝난 뒤 저장 위치가 현재 화면 밖이면 화면 안으로 보정합니다.
        requestAnimationFrame(() => clampPanelToViewport(true));

        setupDrag();
        setupResize();

        document
            .getElementById('bn-add-streamer')
            .addEventListener(
                'click',
                addStreamer
            );

        document
            .getElementById('bn-refresh')
            .addEventListener(
                'click',
                updatePanel
            );

        document
            .getElementById('bn-collapse')
            .addEventListener(
                'click',
                togglePanel
            );

        document
            .getElementById('bn-close')
            .addEventListener(
                'click',
                closePanel
            );

        document
            .getElementById('bn-settings-button')
            .addEventListener(
                'click',
                toggleSettingsPanel
            );

        document
            .getElementById('bn-series-button')
            .addEventListener('click', openSeriesManager);

        document
            .getElementById('bn-opacity-slider')
            .addEventListener(
                'input',
                changeOpacity
            );

        document
            .getElementById('bn-export')
            .addEventListener(
                'click',
                exportData
            );

        document
            .getElementById('bn-import')
            .addEventListener(
                'click',
                () => {
                    document
                        .getElementById(
                            'bn-import-file'
                        )
                        .click();
                }
            );

        document
            .getElementById('bn-import-file')
            .addEventListener(
                'change',
                importData
            );

        document.getElementById('bn-online-config').addEventListener('click', configureOnlineStorage);
        document.getElementById('bn-online-sync').addEventListener('click', syncOnlineData);
        updateOnlineSyncTooltip();
        updateOnlineStatus();

        document.getElementById('bn-view-mode').addEventListener('change', event => {
            data.settings.streamerViewMode = event.target.value;
            data.settings.streamerPageIndex = 0;
            saveData();
            updatePanel();
        });

        /*
         * ResizeObserver
         *
         * 가로 폭에 따라 내부 배율을 계산합니다.
         */
        if (
            typeof ResizeObserver !==
            'undefined'
        ) {

            resizeObserver =
                new ResizeObserver(
                    entries => {

                        for (const entry of entries) {

                            const width =
                                entry.contentRect.width;

                            applyScale(width);
                        }
                    }
                );

            resizeObserver.observe(panel);
        }

        updatePanel();
    }


    /************************************************
     * 패널 크기 적용
     ************************************************/

    function applyPanelSize() {

        if (!panel) {
            return;
        }

        panel.style.width =
            data.settings.panelWidth + 'px';

        panel.style.height =
            data.settings.panelHeight + 'px';

        applyScale(
            data.settings.panelWidth
        );
    }


    /************************************************
     * 가로 폭 → 내부 배율
     ************************************************/

    function applyScale(width) {

        if (!panel) {
            return;
        }

        /*
         * 기본 430px = 1배
         *
         * 너무 작아져서 UI가 무너지는 것을
         * 막기 위해 0.72 ~ 1.35배로 제한
         */
        const scale =
            Math.min(
                1.35,
                Math.max(
                    0.72,
                    width / BASE_WIDTH
                )
            );

        panel.style.setProperty(
            '--bn-scale',
            scale
        );
    }


    /************************************************
     * 위치 적용
     ************************************************/

    function applyPanelPosition() {

        if (!panel) {
            return;
        }

        // 기본 위치: 화면 오른쪽에서 약 21px 띄우고 세로 가운데 정렬.
        // 이 위치는 초기 배치와 화면 크기 변경 때만 사용하며, 사용자는 평소 자유롭게 이동할 수 있습니다.
        panel.style.left = 'auto';
        panel.style.right = '21px';
        const height = panel.getBoundingClientRect().height || data.settings.panelHeight || 600;
        panel.style.top = Math.max(0, Math.round((window.innerHeight - height) / 2)) + 'px';
    }


    /************************************************
     * 현재 브라우저 화면에 맞춰 위치 보정
     ************************************************/

    function clampPanelToViewport(save = false) {

        if (!panel || panel.style.display === 'none') {
            return;
        }

        // 화면 안에 들어오도록 보정하되, 일반적인 수동 이동에서는 위치를 강제로 우측에 고정하지 않습니다.
        const rect = panel.getBoundingClientRect();
        const width = Math.min(rect.width || 0, window.innerWidth);
        const height = Math.min(rect.height || 0, window.innerHeight);
        const left = Math.max(0, Math.min(rect.left, window.innerWidth - width));
        const top = Math.max(0, Math.min(rect.top, window.innerHeight - height));
        panel.style.left = Math.round(left) + 'px';
        panel.style.right = 'auto';
        panel.style.top = Math.round(top) + 'px';

        if (save) {
            data.settings.panelX = Math.round(left);
            data.settings.panelY = Math.round(top);
            saveData();
        }
    }

    function handleViewportChange() {
        // 모니터 이동/전체화면 전환/창 크기 변경 시 기본 위치로 재배치합니다.
        // 수동 이동은 평상시 허용하되, 뷰포트가 바뀌면 우측에서 21px 띄운 세로 중앙으로 초기화합니다.
        if (!panel || panel.style.display === 'none') return;
        panel.style.left = 'auto';
        panel.style.right = '21px';
        const height = Math.min(panel.getBoundingClientRect().height || data.settings.panelHeight || 600, window.innerHeight);
        panel.style.top = Math.max(0, Math.round((window.innerHeight - height) / 2)) + 'px';
        clampPanelToViewport(true);
    }


    /************************************************
     * 투명도
     ************************************************/

    function applyOpacity() {

        if (!panel) {
            return;
        }

        panel.style.setProperty(
            '--bn-opacity',
            data.settings.opacity
        );

        const slider =
            document.getElementById(
                'bn-opacity-slider'
            );

        const value =
            document.getElementById(
                'bn-opacity-value'
            );

        if (slider) {
            slider.value =
                data.settings.opacity;
        }

        if (value) {
            value.textContent =
                Math.round(
                    data.settings.opacity * 100
                ) + '%';
        }
    }


    function changeOpacity(event) {

        data.settings.opacity =
            parseFloat(event.target.value);

        applyOpacity();
        saveData();
    }


    function toggleSettingsPanel() {

        const el =
            document.getElementById(
                'bn-settings-panel'
            );

        if (!el) {
            return;
        }

        el.classList.toggle('bn-hidden');
    }


    /************************************************
     * 패널 접기
     ************************************************/

    function togglePanel() {

        if (!panel) return;

        if (!data.settings.panelCollapsed) {
            savePanelSize();
        }

        data.settings.panelCollapsed =
            !data.settings.panelCollapsed;

        applyPanelCollapsed();
        saveData();
    }


    function applyPanelCollapsed() {

        if (!panel) {
            return;
        }

        const body =
            document.getElementById(
                'bn-body'
            );

        const button =
            document.getElementById(
                'bn-collapse'
            );

        // 접고 펼칠 때 오른쪽 위 모서리를 기준으로 폭을 바꿉니다.
        const currentRect = panel.getBoundingClientRect();
        const fixedRight = currentRect.right;
        const targetWidth = data.settings.panelCollapsed
            ? data.settings.collapsedWidth
            : data.settings.panelWidth;

        if (data.settings.panelCollapsed) {
            body.style.display = 'none';
            panel.style.minWidth = data.settings.collapsedWidth + 'px';
            panel.style.minHeight = data.settings.collapsedHeight + 'px';
            panel.style.width = data.settings.collapsedWidth + 'px';
            panel.style.height = data.settings.collapsedHeight + 'px';
            applyScale(data.settings.collapsedWidth);
            button.textContent = '+';
        } else {
            body.style.display = '';
            panel.style.minWidth = '';
            panel.style.minHeight = '';
            panel.style.width = data.settings.panelWidth + 'px';
            panel.style.height = data.settings.panelHeight + 'px';
            applyScale(data.settings.panelWidth);
            button.textContent = '−';
        }

        // 기존 오른쪽 위 위치를 유지하며 크기만 변경합니다.
        panel.style.left = Math.round(fixedRight - targetWidth) + 'px';
        panel.style.right = 'auto';
    }


    /************************************************
     * 패널 닫기
     ************************************************/

    function closePanel() {

        if (!panel) {
            return;
        }

        data.settings.panelClosed =
            true;

        saveData();

        panel.style.display =
            'none';

        createReopenButton();
    }


    /************************************************
     * 다시 열기 버튼
     ************************************************/

    function createReopenButton() {

        if (reopenButton) {
            reopenButton.style.display =
                'flex';
            return;
        }

        reopenButton =
            document.createElement('button');

        reopenButton.id =
            'bn-reopen';

        reopenButton.textContent =
            '봉누도';

        reopenButton.title =
            '봉누도 시청 기록 열기';

        document.body.appendChild(
            reopenButton
        );

        reopenButton.addEventListener(
            'click',
            openPanel
        );
    }


    function openPanel() {

        if (!panel) {
            createPanel();
        }

        panel.style.display =
            '';

        if (reopenButton) {
            reopenButton.style.display =
                'none';
        }

        data.settings.panelClosed =
            false;

        saveData();
    }


    /************************************************
     * 패널 드래그
     ************************************************/

    function setupDrag() {

        if (!panel) {
            return;
        }

        const header =
            document.getElementById(
                'bn-drag-handle'
            );

        if (!header) {
            return;
        }

        let dragging = false;

        let startX = 0;
        let startY = 0;

        let startLeft = 0;
        let startTop = 0;

        header.addEventListener(
            'mousedown',
            event => {

                /*
                 * 버튼을 누른 경우 드래그하지 않음
                 */
                if (
                    event.target.closest(
                        'button'
                    )
                ) {
                    return;
                }

                dragging = true;

                const rect =
                    panel.getBoundingClientRect();

                startX =
                    event.clientX;

                startY =
                    event.clientY;

                startLeft =
                    rect.left;

                startTop =
                    rect.top;

                document.body.style.userSelect =
                    'none';

                event.preventDefault();
            }
        );

        document.addEventListener(
            'mousemove',
            event => {

                if (!dragging) {
                    return;
                }

                const dx =
                    event.clientX - startX;

                const dy =
                    event.clientY - startY;

                // 평상시에는 가로·세로 모두 자유롭게 이동 가능하며, 화면 변경 때만 기본 위치로 초기화합니다.
                let left = startLeft + dx;

                let top =
                    startTop + dy;

                /*
                 * 화면 밖으로 너무 멀리
                 * 나가지 않도록 최소한의 제한
                 */
                const rect =
                    panel.getBoundingClientRect();

                const maxLeft =
                    window.innerWidth - 40;

                const maxTop =
                    window.innerHeight - 40;

                left =
                    Math.min(
                        maxLeft,
                        Math.max(
                            -rect.width + 40,
                            left
                        )
                    );

                top =
                    Math.min(
                        maxTop,
                        Math.max(
                            20,
                            top
                        )
                    );

                panel.style.left = left + 'px';
                panel.style.right = 'auto';

                panel.style.top =
                    top + 'px';
            }
        );

        document.addEventListener(
            'mouseup',
            () => {

                if (!dragging) {
                    return;
                }

                dragging = false;

                document.body.style.userSelect =
                    '';

                clampPanelToViewport(false);
                savePanelPosition();
            }
        );
    }


    function savePanelPosition() {

        if (!panel) {
            return;
        }

        const rect =
            panel.getBoundingClientRect();

        data.settings.panelX =
            Math.round(rect.left);

        data.settings.panelY =
            Math.round(rect.top);

        saveData();
    }


    /************************************************
     * 패널 크기 조절
     ************************************************/

    function setupResize() {

        if (!panel) {
            return;
        }

        const handles =
            panel.querySelectorAll(
                '.bn-resize-handle, .bn-resize-corner'
            );

        handles.forEach(handle => {

            handle.addEventListener(
                'mousedown',
                event => {

                    event.preventDefault();
                    event.stopPropagation();

                    startResize(
                        getResizeDirection(
                            handle
                        ),
                        event
                    );
                }
            );
        });
    }


    function getResizeDirection(handle) {

        if (
            handle.classList.contains(
                'bn-resize-left'
            )
        ) {
            return 'left';
        }

        if (
            handle.classList.contains(
                'bn-resize-right'
            )
        ) {
            return 'right';
        }

        if (
            handle.classList.contains(
                'bn-resize-top'
            )
        ) {
            return 'top';
        }

        if (
            handle.classList.contains(
                'bn-resize-bottom'
            )
        ) {
            return 'bottom';
        }

        if (
            handle.classList.contains(
                'bn-corner-tl'
            )
        ) {
            return 'top-left';
        }

        if (
            handle.classList.contains(
                'bn-corner-tr'
            )
        ) {
            return 'top-right';
        }

        if (
            handle.classList.contains(
                'bn-corner-bl'
            )
        ) {
            return 'bottom-left';
        }

        return 'bottom-right';
    }


    function startResize(
        direction,
        event
    ) {

        const rect =
            panel.getBoundingClientRect();

        resizeState = {

            direction,

            startMouseX:
                event.clientX,

            startMouseY:
                event.clientY,

            startLeft:
                rect.left,

            startTop:
                rect.top,

            startWidth:
                rect.width,

            startHeight:
                rect.height

        };

        document.body.style.userSelect =
            'none';

        document.addEventListener(
            'mousemove',
            handleResize
        );

        document.addEventListener(
            'mouseup',
            stopResize
        );
    }


    function handleResize(event) {

        if (!resizeState) {
            return;
        }

        const r =
            resizeState;

        const dx =
            event.clientX -
            r.startMouseX;

        const dy =
            event.clientY -
            r.startMouseY;

        let width =
            r.startWidth;

        let height =
            r.startHeight;

        let left =
            r.startLeft;

        let top =
            r.startTop;

        /*
         * 오른쪽
         */
        if (
            r.direction.includes('right')
        ) {

            width =
                r.startWidth + dx;

            width =
                Math.min(
                    MAX_WIDTH,
                    Math.max(
                        MIN_WIDTH,
                        width
                    )
                );
        }

        /*
         * 왼쪽
         *
         * 오른쪽 위치를 고정하고
         * 왼쪽을 움직입니다.
         */
        if (
            r.direction.includes('left')
        ) {

            width =
                r.startWidth - dx;

            width =
                Math.min(
                    MAX_WIDTH,
                    Math.max(
                        MIN_WIDTH,
                        width
                    )
                );

            left =
                r.startLeft +
                (
                    r.startWidth -
                    width
                );
        }

        /*
         * 아래쪽
         */
        if (
            r.direction.includes('bottom')
        ) {

            height =
                r.startHeight + dy;

            height =
                Math.max(
                    MIN_HEIGHT,
                    height
                );
        }

        /*
         * 위쪽
         *
         * 아래 위치를 고정하고
         * 위쪽을 움직입니다.
         */
        if (
            r.direction.includes('top')
        ) {

            height =
                r.startHeight - dy;

            height =
                Math.max(
                    MIN_HEIGHT,
                    height
                );

            top =
                r.startTop +
                (
                    r.startHeight -
                    height
                );
        }

        /*
         * 화면 오른쪽/아래쪽을
         * 지나치지 않도록 제한
         */
        if (
            left + width >
            window.innerWidth - 10
        ) {

            left =
                window.innerWidth -
                width -
                10;
        }

        if (
            top + height >
            window.innerHeight - 10
        ) {

            top =
                window.innerHeight -
                height -
                10;
        }

        panel.style.width =
            Math.round(width) + 'px';

        panel.style.height =
            Math.round(height) + 'px';

        panel.style.left =
            Math.round(left) + 'px';

        panel.style.top =
            Math.round(top) + 'px';

        panel.style.right =
            'auto';

        /*
         * 가로 폭이 변경되면
         * ResizeObserver가 내부 배율도 변경
         */
        applyScale(width);
    }


    function stopResize() {

        if (!resizeState) {
            return;
        }

        resizeState = null;

        document.body.style.userSelect =
            '';

        document.removeEventListener(
            'mousemove',
            handleResize
        );

        document.removeEventListener(
            'mouseup',
            stopResize
        );

        savePanelSize();
        requestAnimationFrame(() => fitPanelToContent(false));
    }


    function savePanelSize() {

        if (!panel) {
            return;
        }

        const rect =
            panel.getBoundingClientRect();

        data.settings.panelWidth =
            Math.round(rect.width);

        data.settings.panelHeight =
            Math.round(rect.height);

        data.settings.panelX =
            Math.round(rect.left);

        data.settings.panelY =
            Math.round(rect.top);

        saveData();
    }


    /************************************************
     * 스트리머 접기
     ************************************************/

    function toggleStreamer(streamer) {

        streamer.collapsed =
            !streamer.collapsed;

        saveData();
        updatePanel();
    }


    /************************************************
     * 스트리머 정렬
     ************************************************/

    function getSortedStreamers() {
        return data.streamers.slice().sort((a, b) =>
            (Number(b.lastPlayedAt) || 0) - (Number(a.lastPlayedAt) || 0) ||
            data.streamers.indexOf(a) - data.streamers.indexOf(b)
        );
    }

    function changeStreamerPage(direction) {
        const count = data.streamers.length;
        if (!count) return;
        const current = Math.min(data.settings.streamerPageIndex || 0, count - 1);
        data.settings.streamerPageIndex = (current + direction + count) % count;
        saveData();
        updatePanel();
    }

    function moveStreamer(streamer, direction) {
        const index = data.streamers.indexOf(streamer);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= data.streamers.length) return;
        [data.streamers[index], data.streamers[target]] = [data.streamers[target], data.streamers[index]];
        data.settings.sortMode = 'manual';
        saveData();
        updatePanel();
    }

    function toggleOrderEdit() {
        const container = document.getElementById('bn-streamers');
        if (!container) return;
        container.classList.toggle('bn-order-edit');
        renderStreamers();
    }


    /************************************************
     * 스트리머 수정 메뉴
     ************************************************/

    function openStreamerEditMenu(streamer) {

        closeBnModal();

        const modal = createBnModal('스트리머 수정');

        const body = document.createElement('div');
        body.className = 'bn-modal-body';

        body.innerHTML = `
            <label class="bn-modal-label">스트리머 이름</label>
            <input class="bn-modal-input" id="bn-edit-streamer-name" type="text">
            <div class="bn-modal-actions">
                <button class="bn-modal-button" id="bn-edit-streamer-save">저장</button>
                <button class="bn-modal-button" id="bn-edit-streamer-cancel">취소</button>
            </div>
            <div class="bn-modal-danger-row">
                <button class="bn-modal-danger" id="bn-edit-streamer-delete">스트리머 삭제</button>
            </div>
        `;

        modal.content.appendChild(body);

        const nameInput = body.querySelector('#bn-edit-streamer-name');
        nameInput.value = streamer.name;

        body.querySelector('#bn-edit-streamer-save').addEventListener('click', () => {
            const name = nameInput.value.trim();
            if (!name) {
                alert('스트리머 이름을 입력하세요.');
                return;
            }

            if (data.streamers.some(s => s !== streamer && s.name === name)) {
                alert('이미 등록된 스트리머입니다.');
                return;
            }

            streamer.name = name;
            saveData();
            closeBnModal();
            updatePanel();
        });

        body.querySelector('#bn-edit-streamer-cancel').addEventListener('click', closeBnModal);

        body.querySelector('#bn-edit-streamer-delete').addEventListener('click', () => {
            closeBnModal();
            deleteStreamer(streamer);
        });

        showBnModal(modal);
        setTimeout(() => nameInput.focus(), 0);
        nameInput.select();
    }


    /************************************************
     * 일괄 추가 - CHZZK 채널/VOD 목록
     ************************************************/

    function extractChzzkChannelId(url) {

        try {
            const u = new URL(String(url).trim());

            if (!u.hostname.toLowerCase().endsWith('chzzk.naver.com')) {
                return null;
            }

            const parts = u.pathname.split('/').filter(Boolean);

            if (!parts.length) {
                return null;
            }

            /*
             * 일반 채널 주소는 https://chzzk.naver.com/{channelId}
             * 이며 /live/, /chat/ 뒤에도 동일한 채널 ID가 올 수 있습니다.
             */
            if (/^[a-f0-9]{32}$/i.test(parts[0])) {
                return parts[0];
            }

            const knownPrefixes = ['live', 'chat', 'channel'];
            if (knownPrefixes.includes(parts[0].toLowerCase()) && parts[1]) {
                return /^[a-f0-9]{32}$/i.test(parts[1])
                    ? parts[1]
                    : null;
            }

            return null;
        } catch (e) {
            return null;
        }
    }


    function formatBulkPublishDate(value) {
        const match = String(value || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (!match) return String(value || '');
        return `${Number(match[2])}/${Number(match[3])}`;
    }


    function createBulkEntryFromVideo(video) {
        const videoNo = video.videoNo != null
            ? String(video.videoNo)
            : '';

        const url = videoNo
            ? `https://chzzk.naver.com/video/${videoNo}`
            : '';

        return {
            day: '',
            title: String(video.videoTitle || '').trim(),
            url,
            type: 'chzzk',
            videoId: normalizeUrl(url),
            watchedSeconds: 0,
            percent: 0,
            completed: false,
            publishedDate: formatBulkPublishDate(video.publishDate)
        };
    }


    function isEntryAlreadyRegistered(streamer, video) {
        const videoNo = video.videoNo != null ? String(video.videoNo) : '';
        const url = videoNo ? normalizeUrl(`https://chzzk.naver.com/video/${videoNo}`) : '';
        const videoId = String(video.videoId || '');

        return streamer.entries.some(entry => {
            if (videoNo && getChzzkVideoNo(entry) === videoNo) return true;
            if (url && normalizeUrl(entry.url || '') === url) return true;
            if (videoId && String(entry.videoId || '') === videoId) return true;
            return false;
        });
    }


    function fetchChzzkChannelVideos(channelId, startDate, endDate, callback) {

        const all = [];
        let page = 0;
        let stopped = false;
        let requestCount = 0;
        const maxPages = 200;

        function requestNextPage() {
            if (stopped) return;

            if (page >= maxPages) {
                callback(null, '검색 가능한 페이지 수를 초과했습니다. 날짜 범위를 조금 좁혀주세요.');
                return;
            }

            requestCount++;

            const query = new URLSearchParams({
                sortType: 'LATEST',
                pagingType: 'PAGE',
                page: String(page),
                size: '30',
                publishDateAt: '',
                videoType: ''
            });

            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.chzzk.naver.com/service/v1/channels/${encodeURIComponent(channelId)}/videos?${query.toString()}`,
                timeout: 10000,
                onload: response => {
                    try {
                        if (response.status < 200 || response.status >= 300) {
                            callback(null, `CHZZK VOD 목록을 불러오지 못했습니다. (HTTP ${response.status})`);
                            return;
                        }

                        const json = JSON.parse(response.responseText);
                        const content = json?.content;
                        const pageData = content?.data;
                        const videos = Array.isArray(pageData) ? pageData : [];

                        if (!videos.length) {
                            stopped = true;
                            finish();
                            return;
                        }

                        let shouldContinue = true;

                        for (const video of videos) {
                            const publishDate = String(video.publishDate || '');
                            const dateOnly = publishDate.slice(0, 10);

                            if (!dateOnly) continue;

                            if (dateOnly < startDate) {
                                shouldContinue = false;
                                continue;
                            }

                            if (dateOnly > endDate) {
                                continue;
                            }

                            all.push(video);
                        }

                        page++;

                        if (!shouldContinue || videos.length < 30) {
                            stopped = true;
                            finish();
                            return;
                        }

                        requestNextPage();
                    } catch (error) {
                        callback(null, 'CHZZK VOD 목록 응답을 해석하지 못했습니다.');
                    }
                },
                onerror: () => callback(null, 'CHZZK VOD 목록 요청에 실패했습니다.'),
                ontimeout: () => callback(null, 'CHZZK VOD 목록 요청 시간이 초과되었습니다.')
            });
        }

        function finish() {
            const unique = [];
            const seen = new Set();

            for (const video of all) {
                const key = String(video.videoNo || video.videoId || '');
                if (!key || seen.has(key)) continue;
                seen.add(key);
                unique.push(video);
            }

            unique.sort((a, b) =>
                String(a.publishDate || '').localeCompare(String(b.publishDate || ''))
            );

            callback(unique, null);
        }

        requestNextPage();
    }


    function openBulkAddModal(streamer) {

        closeBnModal();

        const modal = createBnModal(`${streamer.name} · 일괄 추가`);
        const body = document.createElement('div');
        body.className = 'bn-modal-body';

        body.innerHTML = `
            <div class="bn-bulk-help">
                스트리머의 치지직 채널 링크와 날짜 범위를 입력한 뒤 영상을 불러옵니다.
            </div>

            <label class="bn-modal-label">치지직 스트리머 링크</label>
            <div class="bn-bulk-link-row">
                <input class="bn-modal-input" id="bn-bulk-channel-url" type="text" placeholder="https://chzzk.naver.com/채널ID">
                <button class="bn-modal-button bn-bulk-save-link" id="bn-bulk-save-link" type="button">링크 저장</button>
            </div>

            <div class="bn-bulk-date-row">
                <div>
                    <label class="bn-modal-label">시작 날짜</label>
                    <input class="bn-modal-input" id="bn-bulk-start-date" type="date">
                </div>
                <div>
                    <label class="bn-modal-label">종료 날짜</label>
                    <input class="bn-modal-input" id="bn-bulk-end-date" type="date">
                </div>
            </div>

            <div class="bn-modal-actions">
                <button class="bn-modal-button bn-bulk-load" id="bn-bulk-load">영상 불러오기</button>
                <button class="bn-modal-button" id="bn-bulk-cancel">닫기</button>
            </div>

            <div id="bn-bulk-status" class="bn-bulk-status"></div>
            <div id="bn-bulk-results"></div>
        `;

        modal.content.appendChild(body);

        const channelInput = body.querySelector('#bn-bulk-channel-url');
        const startInput = body.querySelector('#bn-bulk-start-date');
        const endInput = body.querySelector('#bn-bulk-end-date');
        const loadButton = body.querySelector('#bn-bulk-load');
        const saveLinkButton = body.querySelector('#bn-bulk-save-link');
        const status = body.querySelector('#bn-bulk-status');
        const results = body.querySelector('#bn-bulk-results');

        /* 일괄추가에서 저장한 링크만 사용합니다. 처음 사용하는 스트리머는 빈칸입니다. */
        if (typeof streamer.bulkAddChannelUrl === 'string') {
            channelInput.value = streamer.bulkAddChannelUrl;
        }

        const today = new Date();
        const end = toLocalDateInputValue(today);
        const start = toLocalDateInputValue(new Date(today.getTime() - 29 * 86400000));
        startInput.value = start;
        endInput.value = end;

        body.querySelector('#bn-bulk-cancel').addEventListener('click', closeBnModal);

        saveLinkButton.addEventListener('click', () => {
            const enteredUrl = channelInput.value.trim();
            const channelId = extractChzzkChannelId(enteredUrl);

            if (!channelId) {
                alert('올바른 치지직 스트리머 링크를 입력하세요.');
                channelInput.focus();
                return;
            }

            streamer.bulkAddChannelUrl = enteredUrl;
            saveData();
            status.textContent = '이 스트리머의 일괄추가 링크를 저장했습니다.';
        });

        loadButton.addEventListener('click', () => {
            const enteredUrl = channelInput.value.trim();
            const channelId = extractChzzkChannelId(enteredUrl);
            const startDate = startInput.value;
            const endDate = endInput.value;

            if (!channelId) {
                alert('올바른 치지직 스트리머 링크를 입력하세요.');
                return;
            }

            if (!startDate || !endDate || startDate > endDate) {
                alert('시작 날짜와 종료 날짜를 올바르게 입력하세요.');
                return;
            }

            /* 영상 불러오기를 시작하면 수정한 링크도 해당 스트리머에 저장합니다. */
            streamer.bulkAddChannelUrl = enteredUrl;
            saveData();

            results.innerHTML = '';
            status.textContent = '영상을 불러오는 중입니다...';
            loadButton.disabled = true;

            fetchChzzkChannelVideos(channelId, startDate, endDate, (videos, error) => {
                loadButton.disabled = false;

                if (error) {
                    status.textContent = error;
                    return;
                }

                renderBulkResults(streamer, videos, results, status);
            });
        });

        showBnModal(modal);
        setTimeout(() => channelInput.focus(), 0);
    }


    function findStreamerChannelId(streamer) {
        for (const entry of streamer.entries || []) {
            const videoNo = getChzzkVideoNo(entry);
            if (videoNo) {
                /* VOD 상세 API는 channelId를 포함하지 않는 경우가 있어 URL만으로는 알 수 없습니다. */
            }
        }
        return null;
    }


    function toLocalDateInputValue(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }


    function parseBulkPublishedDate(value) {
        const match = String(value || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (!match) return null;

        const date = new Date(
            Number(match[1]),
            Number(match[2]) - 1,
            Number(match[3])
        );

        return Number.isNaN(date.getTime()) ? null : date;
    }


    function parseStoredPublishedDate(value, referenceDate) {
        const match = String(value || '').match(/^(\d{1,2})\/(\d{1,2})$/);
        if (!match || !referenceDate) return null;

        const month = Number(match[1]);
        const day = Number(match[2]);
        const baseYear = referenceDate.getFullYear();
        const candidates = [];

        for (const year of [baseYear - 1, baseYear, baseYear + 1]) {
            const date = new Date(year, month - 1, day);
            if (
                date.getFullYear() === year &&
                date.getMonth() === month - 1 &&
                date.getDate() === day
            ) {
                candidates.push(date);
            }
        }

        if (!candidates.length) return null;

        candidates.sort(
            (a, b) =>
                Math.abs(a.getTime() - referenceDate.getTime()) -
                Math.abs(b.getTime() - referenceDate.getTime())
        );

        return candidates[0];
    }


    function getBulkExistingAnchors(streamer, referenceDate) {
        const anchors = [];

        for (const entry of streamer.entries || []) {
            const date = parseStoredPublishedDate(
                entry.publishedDate,
                referenceDate
            );
            const day = getDayNumber(entry.day);

            if (!date || !Number.isFinite(day) || day >= 999999) {
                continue;
            }

            anchors.push({
                date,
                day,
                entry
            });
        }

        return anchors;
    }


    function calculateBulkDefaultDays(streamer, videos) {
        const defaults = new Array(videos.length);

        /*
         * 일차 자동 계산 규칙 (2.4.7)
         *
         * 핵심은 "날짜별 일차"를 먼저 계산하고, 같은 날짜의 여러 영상만
         * 그 날짜와 다음 날짜 사이를 나누는 것입니다.
         *
         * 예:
         * 9/16 = 2일차
         * 9/17 영상 2개 = 3 / 3.5일차
         * 9/18 = 5일차
         *
         * 기존 entry의 day 값은 절대로 변경하지 않습니다.
         * 이미 등록된 영상도 자동 계산 대상에서 제외합니다.
         */

        const candidates = [];

        for (let i = 0; i < videos.length; i++) {
            const date = parseBulkPublishedDate(videos[i].publishDate);
            if (!date) continue;
            if (isEntryAlreadyRegistered(streamer, videos[i])) continue;

            candidates.push({
                index: i,
                date,
                dateTime: date.getTime()
            });
        }

        candidates.sort((a, b) =>
            a.dateTime - b.dateTime || a.index - b.index
        );

        const referenceDate = candidates.length
            ? candidates[candidates.length - 1].date
            : new Date();

        const anchors = getBulkExistingAnchors(streamer, referenceDate)
            .sort((a, b) =>
                a.date.getTime() - b.date.getTime() || a.day - b.day
            );

        /* 날짜별 기존 기록은 가장 큰 day를 기준점으로 사용합니다. */
        const anchorByDate = new Map();
        for (const anchor of anchors) {
            const key = dateOnlyKey(anchor.date);
            const old = anchorByDate.get(key);
            if (!old || anchor.day > old.day) {
                anchorByDate.set(key, anchor);
            }
        }

        const distinctCandidateDates = [];
        for (const candidate of candidates) {
            if (
                !distinctCandidateDates.length ||
                distinctCandidateDates[distinctCandidateDates.length - 1] !== candidate.dateTime
            ) {
                distinctCandidateDates.push(candidate.dateTime);
            }
        }

        /*
         * 기존 날짜 사이의 신규 날짜에 사용할 기본 day를 계산합니다.
         *
         * 중요한 예외:
         *   이전 2일차 / 다음 5일차 / 중간 날짜 1개라면
         *   3.5가 아니라 3일차부터 시작합니다.
         *   즉, 날짜가 하루 증가할 때 기본적으로 day도 1 증가시키고,
         *   기존 day 간격이 부족할 때만 소수점으로 압축합니다.
         */
        const dateBaseMap = new Map();

        function getAnchorBefore(dateTime) {
            let result = null;
            for (const anchor of anchors) {
                const t = anchor.date.getTime();
                if (t < dateTime) {
                    if (!result || t > result.date.getTime()) result = anchor;
                }
            }
            return result;
        }

        function getAnchorAfter(dateTime) {
            let result = null;
            for (const anchor of anchors) {
                const t = anchor.date.getTime();
                if (t > dateTime) {
                    if (!result || t < result.date.getTime()) result = anchor;
                }
            }
            return result;
        }

        function calendarDayDiff(a, b) {
            const aa = new Date(a.getFullYear(), a.getMonth(), a.getDate());
            const bb = new Date(b.getFullYear(), b.getMonth(), b.getDate());
            return Math.round((bb.getTime() - aa.getTime()) / 86400000);
        }

        /*
         * 각 날짜의 기본 일차를 계산합니다.
         * 같은 날짜의 두 번째/세 번째 영상은 아래에서 별도로 분할합니다.
         */
        for (const dateTime of distinctCandidateDates) {
            const date = new Date(dateTime);
            const dateKey = dateOnlyKey(date);

            /* 해당 날짜에 이미 기존 기록이 있으면 그 day 다음부터 배치 */
            const sameDateAnchor = anchorByDate.get(dateKey);
            if (sameDateAnchor) {
                dateBaseMap.set(dateTime, sameDateAnchor.day);
                continue;
            }

            const previous = getAnchorBefore(dateTime);
            const next = getAnchorAfter(dateTime);

            if (previous && next) {
                const prevDate = previous.date;
                const nextDate = next.date;
                const dateGap = calendarDayDiff(prevDate, nextDate);
                const dayGap = next.day - previous.day;

                /*
                 * 후보 날짜가 여러 개라서 기존 day 간격 안에 전부 들어가지
                 * 못하는 경우에만 전체 구간을 균등 분할합니다.
                 */
                const middleDates = distinctCandidateDates.filter(t =>
                    t > previous.date.getTime() &&
                    t < next.date.getTime()
                );

                const middleIndex = middleDates.indexOf(dateTime);

                if (middleIndex >= 0 && dayGap > 0) {
                    if (dayGap >= middleDates.length + 1) {
                        /* 충분한 정수 공간이 있으면 날짜마다 +1 */
                        dateBaseMap.set(
                            dateTime,
                            previous.day + middleIndex + 1
                        );
                    } else {
                        /* 공간이 부족할 때만 소수점으로 균등 분할 */
                        const step = dayGap / (middleDates.length + 1);
                        dateBaseMap.set(
                            dateTime,
                            previous.day + step * (middleIndex + 1)
                        );
                    }
                    continue;
                }
            }

            if (previous) {
                /* 가장 가까운 기존 기록 이후는 날짜가 하루 지날 때 +1 */
                const daysAfter = Math.max(
                    1,
                    calendarDayDiff(previous.date, date)
                );
                dateBaseMap.set(dateTime, previous.day + daysAfter);
                continue;
            }

            if (next) {
                /* 가장 오래된 기존 기록보다 앞 */
                const daysBefore = Math.max(
                    1,
                    calendarDayDiff(date, next.date)
                );
                dateBaseMap.set(dateTime, next.day - daysBefore);
                continue;
            }

            /* 기존 기록이 하나도 없으면 1일부터 날짜순으로 시작 */
            dateBaseMap.set(
                dateTime,
                distinctCandidateDates.indexOf(dateTime) + 1
            );
        }

        /*
         * 최신 기존 기록보다 뒤에 있는 날짜는 무조건 정수 증가.
         * 같은 날짜가 여러 개면 그 날짜의 정수 구간을 나눕니다.
         */
        let latestAnchor = null;
        for (const anchor of anchors) {
            if (
                !latestAnchor ||
                anchor.date.getTime() > latestAnchor.date.getTime() ||
                (
                    anchor.date.getTime() === latestAnchor.date.getTime() &&
                    anchor.day > latestAnchor.day
                )
            ) {
                latestAnchor = anchor;
            }
        }

        let nextIntegerDay = latestAnchor
            ? latestAnchor.day + 1
            : Math.max(
                1,
                ...anchors.map(a => a.day + 1),
                1
            );

        const newerDates = distinctCandidateDates.filter(dateTime =>
            !latestAnchor || dateTime > latestAnchor.date.getTime()
        );

        for (const dateTime of newerDates) {
            dateBaseMap.set(dateTime, nextIntegerDay);
            nextIntegerDay += 1;
        }

        /*
         * 같은 날짜에 여러 영상이 있으면
         * "현재 날짜의 기본 day ~ 다음 날짜의 기본 day"를 균등 분할합니다.
         *
         * 10/1 3개, 기본 15, 다음 날짜 기본 16:
         *   15 / 15.333 / 15.667
         */
        for (let dateIndex = 0; dateIndex < distinctCandidateDates.length; dateIndex++) {
            const dateTime = distinctCandidateDates[dateIndex];
            const sameDateCandidates = candidates.filter(
                candidate => candidate.dateTime === dateTime
            );

            if (!sameDateCandidates.length) continue;

            const base = dateBaseMap.get(dateTime);
            if (!Number.isFinite(base)) continue;

            let nextBase = null;
            for (let j = dateIndex + 1; j < distinctCandidateDates.length; j++) {
                const candidateNextBase = dateBaseMap.get(distinctCandidateDates[j]);
                if (Number.isFinite(candidateNextBase)) {
                    nextBase = candidateNextBase;
                    break;
                }
            }

            /*
             * 같은 날짜의 영상은 최대 "기본 day + 1"까지만 사용합니다.
             * 따라서 9/17 기본 3일차이고 다음 기존 기록이 5일차여도
             * 9/17 두 영상은 3 / 3.5가 됩니다.
             */
            const oneDayBoundary = Math.floor(base) + 1;

            if (!Number.isFinite(nextBase)) {
                nextBase = oneDayBoundary;
            } else {
                nextBase = Math.min(nextBase, oneDayBoundary);
            }

            if (nextBase <= base) {
                nextBase = base + 1;
            }

            const count = sameDateCandidates.length;
            const step = (nextBase - base) / count;

            sameDateCandidates.forEach((candidate, index) => {
                defaults[candidate.index] = Number(
                    (base + step * index).toFixed(3)
                );
            });
        }

        /* 날짜를 읽을 수 없는 신규 영상은 마지막 정수 다음으로 배정합니다. */
        for (let i = 0; i < videos.length; i++) {
            if (defaults[i] !== undefined) continue;

            const existing = streamer.entries.find(entry => {
                const videoNo = videos[i].videoNo != null
                    ? String(videos[i].videoNo)
                    : '';

                return videoNo && getChzzkVideoNo(entry) === videoNo;
            });

            if (existing) {
                defaults[i] = String(existing.day || '');
            } else {
                defaults[i] = nextIntegerDay;
                nextIntegerDay += 1;
            }
        }

        return defaults;
    }

    function dateOnlyKey(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function renderBulkResults(streamer, videos, results, status) {

        if (!videos.length) {
            status.textContent = '해당 날짜 범위에서 영상을 찾지 못했습니다.';
            return;
        }

        const existingKeys = new Set(
            streamer.entries.map(entry => normalizeUrl(entry.url || ''))
        );

        /*
         * 기존 영상의 실제 업로드 날짜를 기준으로
         * 새 영상의 일차를 계산합니다.
         *
         * 예:
         * 1일차 ─ 새 영상 2개 ─ 2일차
         *        → 1.3 / 1.6일차
         *
         * 기존 일차는 절대로 재계산하지 않습니다.
         */
        const bulkDefaultDays = calculateBulkDefaultDays(
            streamer,
            videos
        );

        const list = document.createElement('div');
        list.className = 'bn-bulk-list';

        const header = document.createElement('div');
        header.className = 'bn-bulk-list-header';
        header.innerHTML = `
            <label><input type="checkbox" id="bn-bulk-select-all"> 전체 선택</label>
            <span>${videos.length}개</span>
        `;
        list.appendChild(header);

        const selectAll = header.querySelector('#bn-bulk-select-all');

        videos.forEach((video, index) => {
            const defaultDay = bulkDefaultDays[index];
            const item = createBulkResultItem(streamer, video, defaultDay, existingKeys);
            list.appendChild(item);
        });

        const actions = document.createElement('div');
        actions.className = 'bn-bulk-confirm-row';
        actions.innerHTML = `
            <span class="bn-bulk-selected-count">0개 선택</span>
            <button class="bn-modal-button" id="bn-bulk-confirm">선택 영상 추가</button>
        `;
        list.appendChild(actions);

        results.appendChild(list);
        status.textContent = '등록할 영상을 확인하고 선택하세요. 검색 단계에서는 저장되지 않습니다.';

        const checkboxes = () => [...list.querySelectorAll('.bn-bulk-check')];
        const updateCount = () => {
            const selected = checkboxes().filter(cb => cb.checked && !cb.disabled).length;
            actions.querySelector('.bn-bulk-selected-count').textContent = `${selected}개 선택`;
        };

        selectAll.addEventListener('change', () => {
            checkboxes().forEach(cb => {
                if (!cb.disabled) cb.checked = selectAll.checked;
            });
            updateCount();
        });

        list.addEventListener('change', event => {
            if (event.target.classList.contains('bn-bulk-check')) updateCount();
        });

        actions.querySelector('#bn-bulk-confirm').addEventListener('click', () => {
            const selectedRows = checkboxes()
                .filter(cb => cb.checked && !cb.disabled)
                .map(cb => cb.closest('.bn-bulk-item'));

            if (!selectedRows.length) {
                alert('추가할 영상을 선택하세요.');
                return;
            }

            let added = 0;
            const currentKeys = new Set(
                streamer.entries.map(entry => normalizeUrl(entry.url || ''))
            );

            for (const row of selectedRows) {
                const video = row._bnVideo;
                const entry = createBulkEntryFromVideo(video);
                const dayInput = row.querySelector('.bn-bulk-day');
                const titleInput = row.querySelector('.bn-bulk-title-input');
                const day = dayInput.value.trim();
                const title = titleInput.value.trim();

                if (!day) continue;
                if (!entry.url || currentKeys.has(entry.videoId)) continue;

                entry.day = day;
                entry.title = title;
                streamer.entries.push(entry);
                currentKeys.add(entry.videoId);
                added++;
            }

            if (added) {
                saveData();
                closeBnModal();
                updatePanel();
                alert(`${added}개 영상을 추가했습니다.`);
            } else {
                alert('추가할 수 있는 영상이 없습니다.');
            }
        });
    }


    function createBulkResultItem(streamer, video, defaultDay, existingKeys) {

        const row = document.createElement('div');
        row.className = 'bn-bulk-item';
        row._bnVideo = video;

        const entryUrl = video.videoNo
            ? normalizeUrl(`https://chzzk.naver.com/video/${video.videoNo}`)
            : '';
        const already = existingKeys.has(entryUrl);

        row.innerHTML = `
            <div class="bn-bulk-check-wrap">
                <input class="bn-bulk-check" type="checkbox" ${already ? 'disabled' : ''}>
            </div>
            <div class="bn-bulk-date">${escapeHtml(formatBulkPublishDate(video.publishDate))}</div>
            <input class="bn-bulk-day" type="text" value="${escapeHtml(defaultDay + '일차')}" title="일차">
            <input class="bn-bulk-title-input" type="text" value="${escapeHtml(video.videoTitle || '')}" placeholder="영상 제목" title="영상 제목">
            ${already ? '<span class="bn-bulk-duplicate">이미 등록</span>' : ''}
        `;

        if (already) row.classList.add('bn-bulk-duplicate-row');

        return row;
    }


    /************************************************
     * 일괄 추가/수정용 모달
     ************************************************/

    function createBnModal(title) {
        const overlay = document.createElement('div');
        overlay.className = 'bn-modal-overlay';
        overlay.innerHTML = `
            <div class="bn-modal" role="dialog" aria-modal="true">
                <div class="bn-modal-header">
                    <span>${escapeHtml(title)}</span>
                    <button class="bn-modal-close" title="닫기">×</button>
                </div>
                <div class="bn-modal-content"></div>
            </div>
        `;

        overlay.querySelector('.bn-modal-close').addEventListener('click', closeBnModal);
        overlay.addEventListener('mousedown', event => {
            if (event.target === overlay) closeBnModal();
        });

        return {
            overlay,
            content: overlay.querySelector('.bn-modal-content')
        };
    }


    function showBnModal(modal) {
        closeBnModal();
        document.body.appendChild(modal.overlay);
        window.__bnActiveModal = modal.overlay;
    }


    function closeBnModal() {
        const active = window.__bnActiveModal;
        if (active && active.parentNode) active.parentNode.removeChild(active);
        window.__bnActiveModal = null;
    }

    /************************************************
     * 스트리머 목록
     ************************************************/

    function renderStreamers() {

        const container =
            document.getElementById(
                'bn-streamers'
            );

        if (!container) {
            return;
        }

        container.innerHTML = '';

        if (!data.streamers.length) {

            container.innerHTML = `
                <div class="bn-empty">
                    등록된 스트리머가 없습니다.
                </div>
            `;

            return;
        }

        const sortedStreamers = getSortedStreamers();
        const pageMode = data.settings.streamerViewMode === 'page';
        if (pageMode) {
            data.settings.streamerPageIndex = Math.min(data.settings.streamerPageIndex || 0, sortedStreamers.length - 1);
            const nav = document.createElement('div');
            nav.className = 'bn-streamer-page-nav';
            nav.innerHTML = `<button type="button" id="bn-page-prev" title="이전 스트리머">‹ <small>${sortedStreamers.length}</small></button><span title="${escapeHtml(sortedStreamers[data.settings.streamerPageIndex].name)}">${escapeHtml(sortedStreamers[data.settings.streamerPageIndex].name)}</span><button type="button" id="bn-page-next" title="다음 스트리머"><small>${data.settings.streamerPageIndex + 1}</small> ›</button>`;
            container.appendChild(nav);
            nav.querySelector('#bn-page-prev').addEventListener('click', () => changeStreamerPage(-1));
            nav.querySelector('#bn-page-next').addEventListener('click', () => changeStreamerPage(1));
        }
        const visibleStreamers = pageMode
            ? sortedStreamers.slice(data.settings.streamerPageIndex, data.settings.streamerPageIndex + 1)
            : sortedStreamers;
        container.classList.toggle('bn-page-mode', pageMode);
        visibleStreamers.forEach(
            (streamer, streamerIndex) => {

                const streamerBox =
                    document.createElement(
                        'div'
                    );

                streamerBox.className =
                    'bn-streamer';

                streamerBox.dataset.streamerId =
                    streamerIndex;

                /*
                 * 헤더
                 */
                const header =
                    document.createElement(
                        'div'
                    );

                header.className =
                    'bn-streamer-header';

                const title =
                    document.createElement(
                        'div'
                    );

                title.className =
                    'bn-streamer-title';

                const streamerChzzkEntries = streamer.entries.filter(
                    entry => entry.type === 'chzzk'
                );
                const allStreamerEntriesCompleted =
                    streamerChzzkEntries.length > 0 &&
                    streamerChzzkEntries.every(entry => !!entry.completed);

                title.innerHTML = `
                    <span class="bn-arrow">
                        ${streamer.collapsed ? '▶' : '▼'}
                    </span>

                    <span class="bn-streamer-name${allStreamerEntriesCompleted ? ' bn-streamer-name-completed' : ''}">
                        ${escapeHtml(streamer.name)}
                    </span>
                `;

                title.addEventListener(
                    'click',
                    () => {
                        toggleStreamer(
                            streamer
                        );
                    }
                );

                header.appendChild(title);

                const headerButtons =
                    document.createElement(
                        'div'
                    );

                headerButtons.className =
                    'bn-streamer-buttons';

                const editButton =
                    createSmallButton(
                        '수정',
                        () => {
                            openStreamerEditMenu(
                                streamer
                            );
                        }
                    );

                const addButton =
                    createSmallButton(
                        '추가',
                        () => {
                            addEntry(
                                streamer
                            );
                        }
                    );

                const bulkAddButton =
                    createSmallButton(
                        '일괄 추가',
                        () => {
                            openBulkAddModal(
                                streamer
                            );
                        }
                    );

                if (container.classList.contains('bn-order-edit')) {
                    headerButtons.appendChild(createSmallButton('▲', () => moveStreamer(streamer, -1)));
                    headerButtons.appendChild(createSmallButton('▼', () => moveStreamer(streamer, 1)));
                }

                headerButtons.appendChild(
                    editButton
                );

                headerButtons.appendChild(
                    addButton
                );

                headerButtons.appendChild(
                    bulkAddButton
                );

                header.appendChild(
                    headerButtons
                );

                streamerBox.appendChild(
                    header
                );

                /*
                 * 내용
                 */
                if (!streamer.collapsed) {

                    const entriesBox =
                        document.createElement(
                            'div'
                        );

                    entriesBox.className =
                        'bn-entries';

                    const chzzkEntries =
                        streamer.entries
                            .filter(
                                entry =>
                                    entry.type ===
                                    'chzzk'
                            )
                            .slice()
                            .sort(
                                (a, b) =>
                                    getDayNumber(a.day) -
                                    getDayNumber(b.day)
                            );

                    if (!chzzkEntries.length) {

                        entriesBox.innerHTML = `
                            <div class="bn-no-entry">
                                등록된 영상이 없습니다.
                            </div>
                        `;

                    } else {

                        chzzkEntries.forEach(
                            entry => {

                                entriesBox.appendChild(
                                    renderEntry(
                                        streamer,
                                        entry
                                    )
                                );
                            }
                        );
                    }

                    if (typeof streamer.entriesHeight === 'number') {
                        entriesBox.style.height = streamer.entriesHeight + 'px';
                        entriesBox.style.maxHeight = 'none';
                    }

                    streamerBox.appendChild(
                        entriesBox
                    );

                    if (pageMode) {
                        const entriesResizeHandle = document.createElement('div');
                        entriesResizeHandle.className = 'bn-entries-resize-handle';
                        entriesResizeHandle.title = '드래그해서 스트리머 영상 목록 높이 조절';
                        entriesResizeHandle.setAttribute('aria-label', '영상 목록 높이 조절');
                        streamerBox.appendChild(entriesResizeHandle);
                        setupEntriesListResize(entriesResizeHandle, entriesBox, streamer);
                    }
                }

                container.appendChild(
                    streamerBox
                );
            }
        );
    }


    /************************************************
     * 스트리머 내부 영상 목록 높이 조절
     ************************************************/

    function setupEntriesListResize(handle, entriesBox, streamer) {
        let drag = null;

        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            drag = {
                startY: event.clientY,
                startHeight: entriesBox.getBoundingClientRect().height
            };
            handle.classList.add('bn-resizing');
            try { handle.setPointerCapture(event.pointerId); } catch (_) {}
        });

        handle.addEventListener('pointermove', event => {
            if (!drag) return;
            event.preventDefault();
            const maxHeight = Math.max(120, Math.min(1200, window.innerHeight * 0.8));
            const nextHeight = Math.max(80, Math.min(maxHeight, drag.startHeight + event.clientY - drag.startY));
            entriesBox.style.maxHeight = 'none';
            entriesBox.style.height = Math.round(nextHeight) + 'px';
            streamer.entriesHeight = Math.round(nextHeight);
        });

        const stopDrag = () => {
            if (!drag) return;
            drag = null;
            handle.classList.remove('bn-resizing');
            saveData();
            // 내부 목록 높이에 맞춰 바깥 패널도 다시 맞춥니다.
            updatePanel();
            requestAnimationFrame(() => fitPanelToContent(true));
        };

        handle.addEventListener('pointerup', stopDrag);
        handle.addEventListener('pointercancel', stopDrag);
        handle.addEventListener('lostpointercapture', stopDrag);
    }


    /************************************************
     * 작은 버튼
     ************************************************/

    function createSmallButton(
        text,
        callback
    ) {

        const button =
            document.createElement(
                'button'
            );

        button.className =
            'bn-small-button';

        button.textContent =
            text;

        button.addEventListener(
            'click',
            event => {

                event.stopPropagation();

                callback();
            }
        );

        return button;
    }


    /************************************************
     * 영상 항목
     ************************************************/

    function renderEntry(
        streamer,
        entry
    ) {

        const box =
            document.createElement(
                'div'
            );

        box.className =
            'bn-entry';

        box.dataset.entryId =
            getEntryDomId(entry);

        const entryDomId = getEntryDomId(entry);
        const isCompletedExpanded =
            !!entry.completed && expandedCompletedEntries.has(entryDomId);

        if (entry.completed && !isCompletedExpanded) {
            box.classList.add('bn-entry-collapsed');
        }

        const percent =
            Math.min(
                100,
                Math.max(
                    0,
                    entry.percent || 0
                )
            );

        const status =
            entry.completed
                ? '✓'
                : `${percent}%`;

        box.innerHTML = `

            <div class="bn-entry-main">

                <div class="bn-entry-title${entry.completed ? ' bn-entry-title-completed' : ''}">
                    ${escapeHtml(entry.day)}${entry.title ? ' ' + escapeHtml(entry.title) : ''}
                </div>

                <div class="bn-entry-status">
                    ${status}
                </div>

            </div>

            <div class="bn-entry-progress">

                <div
                    class="bn-entry-progress-bar"
                    style="width:${percent}%">
                </div>

            </div>

            <div class="bn-entry-buttons"></div>
        `;

        const mainRow = box.querySelector('.bn-entry-main');
        if (entry.completed) {
            const foldButton = document.createElement('button');
            foldButton.type = 'button';
            foldButton.className = 'bn-entry-fold';
            foldButton.textContent = isCompletedExpanded ? '∨' : '>';
            foldButton.title = isCompletedExpanded ? '완료 영상 접기' : '완료 영상 펼치기';
            foldButton.setAttribute('aria-label', foldButton.title);
            foldButton.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (expandedCompletedEntries.has(entryDomId)) {
                    expandedCompletedEntries.delete(entryDomId);
                } else {
                    expandedCompletedEntries.add(entryDomId);
                }
                updatePanel();
            });
            mainRow.appendChild(foldButton);
        }

        const buttons =
            box.querySelector(
                '.bn-entry-buttons'
            );

        const openButton =
            createSmallButton(
                '보기',
                () => {
                    openEntry(entry);
                }
            );

        const editButton =
            createSmallButton(
                '수정',
                () => {
                    editEntry(
                        streamer,
                        entry
                    );
                }
            );

        const completeButton =
            createSmallButton(
                entry.completed
                    ? '완료취소'
                    : '완료',
                () => {

                    if (
                        entry.completed
                    ) {

                        undoCompleteEntry(
                            entry
                        );

                    } else {

                        completeEntry(
                            entry
                        );
                    }
                }
            );

        const resetButton =
            createSmallButton(
                '초기화',
                () => {
                    resetEntry(
                        entry
                    );
                }
            );

        const deleteButton =
            createSmallButton(
                '삭제',
                () => {
                    deleteEntry(
                        streamer,
                        entry
                    );
                }
            );

        buttons.appendChild(
            openButton
        );

        buttons.appendChild(
            editButton
        );

        buttons.appendChild(
            completeButton
        );

        buttons.appendChild(
            resetButton
        );

        buttons.appendChild(
            deleteButton
        );


        /*
         * 우측 하단에는 entry.day가 아니라
         * CHZZK 실제 업로드 날짜를 표시합니다.
         */
        const dateInput =
            document.createElement('input');

        dateInput.type = 'text';

        dateInput.className =
            'bn-entry-date';

        dateInput.placeholder =
            '날짜';

        dateInput.value =
            entry.publishedDate
                ? String(entry.publishedDate)
                : '';

        dateInput.title =
            '치지직 영상 업로드 날짜';

        dateInput.addEventListener(
            'click',
            event => {
                event.stopPropagation();
            }
        );

        dateInput.addEventListener(
            'mousedown',
            event => {
                event.stopPropagation();
            }
        );

        dateInput.addEventListener(
            'change',
            () => {

                entry.publishedDate =
                    dateInput.value.trim();

                saveData();
            }
        );

        dateInput.addEventListener(
            'keydown',
            event => {

                if (event.key === 'Enter') {

                    event.preventDefault();

                    dateInput.blur();
                }
            }
        );

        box.appendChild(dateInput);

        /*
         * 기존 데이터에 날짜가 없으면
         * CHZZK에서 실제 업로드 날짜를 자동으로 가져옵니다.
         */
        if (!entry.publishedDate) {

            fetchChzzkPublishDate(
                entry,
                formattedDate => {

                    if (
                        formattedDate &&
                        dateInput.isConnected
                    ) {

                        dateInput.value =
                            formattedDate;
                    }
                }
            );
        }

        return box;

    }


    function getEntryDomId(entry) {

        /*
         * 객체 자체를 ID로 사용할 수 없으므로
         * URL 기반으로 안전하게 생성
         */
        return btoa(
            unescape(
                encodeURIComponent(
                    entry.videoId || entry.url
                )
            )
        )
            .replace(/[^a-zA-Z0-9_-]/g, '')
            .slice(0, 80);
    }


    /************************************************
     * 특정 항목 진행률만 갱신
     ************************************************/

    function updateEntryProgressInPanel() {

        if (!panel || !currentEntry) {
            return;
        }

        const id =
            getEntryDomId(
                currentEntry
            );

        const entryElement =
            Array.from(
                panel.querySelectorAll(
                    '.bn-entry'
                )
            ).find(
                el =>
                    el.dataset.entryId === id
            );

        if (!entryElement) {
            return;
        }

        const percent =
            Math.min(
                100,
                Math.max(
                    0,
                    currentEntry.percent || 0
                )
            );

        const bar =
            entryElement.querySelector(
                '.bn-entry-progress-bar'
            );

        if (bar) {
            bar.style.width =
                percent + '%';
        }

        const status =
            entryElement.querySelector(
                '.bn-entry-status'
            );

        if (status) {

            status.textContent =
                currentEntry.completed
                    ? '✓'
                    : `${percent}%`;
        }
    }


    /************************************************
     * 내용 높이에 맞춰 패널 아래쪽 빈 공간 정리
     ************************************************/

    function fitPanelToContent(allowGrow = false) {
        if (!panel || data.settings.panelCollapsed || resizeState) return;

        const body = document.getElementById('bn-body');
        const streamers = document.getElementById('bn-streamers');
        if (!body || !streamers) return;

        const originalHeight = panel.getBoundingClientRect().height;
        const saved = {
            panelHeight: panel.style.height,
            bodyFlex: body.style.flex,
            bodyHeight: body.style.height,
            bodyMinHeight: body.style.minHeight,
            streamersFlex: streamers.style.flex,
            streamersHeight: streamers.style.height,
            streamersMinHeight: streamers.style.minHeight,
            streamersOverflowY: streamers.style.overflowY,
            streamersOverflow: streamers.style.overflow
        };

        // 임시로 자연 높이를 측정해 flex 영역에 가려진 항목도 계산합니다.
        panel.style.height = 'auto';
        body.style.flex = '0 0 auto';
        body.style.height = 'auto';
        body.style.minHeight = '0';
        streamers.style.flex = '0 0 auto';
        streamers.style.height = 'auto';
        streamers.style.minHeight = '0';
        streamers.style.overflowY = 'visible';
        streamers.style.overflow = 'visible';
        const naturalHeight = Math.ceil(panel.getBoundingClientRect().height);

        panel.style.height = saved.panelHeight;
        body.style.flex = saved.bodyFlex;
        body.style.height = saved.bodyHeight;
        body.style.minHeight = saved.bodyMinHeight;
        streamers.style.flex = saved.streamersFlex;
        streamers.style.height = saved.streamersHeight;
        streamers.style.minHeight = saved.streamersMinHeight;
        streamers.style.overflowY = saved.streamersOverflowY;
        streamers.style.overflow = saved.streamersOverflow;

        const top = panel.getBoundingClientRect().top;
        const maxHeight = Math.max(220, window.innerHeight - Math.max(0, top) - 8);
        const naturalLimited = Math.min(naturalHeight, maxHeight);
        const targetHeight = allowGrow ? naturalLimited : Math.min(originalHeight, naturalLimited);
        const finalHeight = Math.max(220, Math.round(targetHeight));

        if (Math.abs(originalHeight - finalHeight) > 2) {
            panel.style.height = finalHeight + 'px';
            data.settings.panelHeight = finalHeight;
            saveData();
            clampPanelToViewport(false);
        }
    }


    /************************************************
     * 패널 전체 갱신
     ************************************************/

    function updatePanel() {

        if (!panel) {
            return;
        }

        const titleElement = document.getElementById('bn-title-text');
        if (titleElement) titleElement.textContent = getActiveSeriesName() + ' 시청 기록';
        updateCurrentVideo();
        renderStreamers();
        applyPanelCollapsed();
        applyOpacity();

        const viewMode = document.getElementById('bn-view-mode');
        if (viewMode) viewMode.value = data.settings.streamerViewMode || 'scroll';

        /*
         * 현재 크기를 유지
         */
        if (!resizeState) {
            if (data.settings.panelCollapsed) {
                panel.style.width = data.settings.collapsedWidth + 'px';
                panel.style.height = data.settings.collapsedHeight + 'px';
                applyScale(data.settings.collapsedWidth);
            } else {
                panel.style.width = data.settings.panelWidth + 'px';
                panel.style.height = data.settings.panelHeight + 'px';
                applyScale(data.settings.panelWidth);

                // 두 보기 방식 모두 내용이 짧으면 아래쪽 빈 공간을 줄이고,
                // 내용이 길면 패널 높이를 유지한 채 목록에 스크롤을 표시합니다.
                requestAnimationFrame(() => fitPanelToContent(false));
            }
        }
    }


    /************************************************
     * 온라인 저장소 동기화
     ************************************************/

    function getOnlineConfig() {
        return {
            url: String(GM_getValue(ONLINE_URL_KEY, '') || '').trim(),
            key: String(GM_getValue(ONLINE_API_KEY, '') || '').trim()
        };
    }

    function updateOnlineSyncTooltip() {
        const button = document.getElementById('bn-online-sync');
        if (!button) return;

        const lastSync = String(GM_getValue(ONLINE_LAST_SYNC_KEY, '') || '').trim();
        if (!lastSync) {
            button.title = '마지막 동기화 시간: 기록 없음';
            return;
        }

        const timestamp = Number(lastSync);
        const date = Number.isFinite(timestamp) && timestamp > 0
            ? new Date(timestamp)
            : new Date(lastSync);

        button.title = Number.isNaN(date.getTime())
            ? '마지막 동기화 시간: 기록 없음'
            : '마지막 동기화: ' + date.toLocaleString();
    }

    function updateOnlineStatus(message) {
        const el = document.getElementById('bn-online-status');
        if (!el) return;
        if (message) {
            el.textContent = message;
            return;
        }
        const config = getOnlineConfig();
        el.textContent = config.url && config.key
            ? '온라인 저장소 연결 설정됨'
            : '온라인 저장소 미설정';
    }

    // 사이트 진입/새로고침 시 GitHub의 최신 스크립트 버전을 한 번 확인합니다.
    function checkLatestScriptVersion(openUpdatePage = false) {
        const label = document.getElementById('bn-version-label');
        if (!label || typeof GM_xmlhttpRequest !== 'function') return;

        // 클릭 이벤트 안에서 탭을 먼저 열어 비동기 응답後 팝업 차단을 피합니다.
        const updateTab = openUpdatePage ? window.open('about:blank', '_blank') : null;

        GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://raw.githubusercontent.com/Qb707/chzzk-watch-history/main/chzzk-watch-history.user.js?check=' + Date.now(),
            timeout: 15000,
            onload: response => {
                if (response.status < 200 || response.status >= 300) return;
                const match = String(response.responseText || '').match(/^\s*\/\/ @version\s+([^\s]+)/m);
                if (!match) return;

                const latest = match[1].trim();
                const currentParts = SCRIPT_VERSION.split('.').map(Number);
                const latestParts = latest.split('.').map(Number);
                let comparison = 0;
                for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
                    const a = currentParts[i] || 0;
                    const b = latestParts[i] || 0;
                    if (b !== a) { comparison = b > a ? 1 : -1; break; }
                }

                if (comparison > 0) {
                    label.textContent = 'V' + SCRIPT_VERSION + ' · 업데이트 있음';
                    label.title = '최신 버전 V' + latest + '이 있습니다. Tampermonkey 대시보드에서 업데이트해 주세요.';
                    label.style.color = '#ffd166';
                    if (updateTab) updateTab.location.href = 'https://raw.githubusercontent.com/Qb707/chzzk-watch-history/main/chzzk-watch-history.user.js';
                    else if (openUpdatePage) alert('업데이트 탭이 차단되었습니다. 브라우저의 팝업 허용을 확인해주세요.');
                } else {
                    label.textContent = 'V' + SCRIPT_VERSION;
                    label.title = comparison === 0
                        ? '최신 버전입니다.'
                        : '현재 설치된 버전이 GitHub 최신 버전보다 높습니다.';
                    label.style.color = 'rgba(255,255,255,0.48)';
                    if (updateTab) updateTab.close();
                    if (openUpdatePage) alert('현재 최신 버전입니다. (V' + SCRIPT_VERSION + ')');
                }
            },
            onerror: () => {
                label.title = '최신 버전을 확인하지 못했습니다. 네트워크 또는 GitHub 연결을 확인해 주세요.';
                if (updateTab) updateTab.close();
                if (openUpdatePage) alert('GitHub 연결에 실패했습니다.');
            },
            ontimeout: () => {
                label.title = '최신 버전 확인 시간이 초과되었습니다.';
                if (updateTab) updateTab.close();
                if (openUpdatePage) alert('최신 버전 확인 시간이 초과되었습니다.');
            }
        });
    }

    function configureOnlineStorage() {
        const current = getOnlineConfig();
        const enteredUrl = prompt('Google Apps Script 웹 앱 URL을 입력해주세요.', current.url);
        if (enteredUrl === null) return;
        const url = enteredUrl.trim();
        if (!/^https:\/\/script\.google\.com\/macros\/s\/[^\s]+\/exec$/.test(url)) {
            alert('웹 앱 URL 형식이 올바르지 않습니다.\nhttps://script.google.com/macros/s/.../exec 형식이어야 합니다.');
            return;
        }
        const enteredKey = prompt('접속 키(API_KEY)를 입력해주세요. 키는 이 PC의 Tampermonkey 저장소에만 보관됩니다.', current.key);
        if (enteredKey === null) return;
        const key = enteredKey.trim();
        if (!key) {
            alert('접속 키를 입력해주세요.');
            return;
        }
        const endpointChanged = url !== current.url || key !== current.key;
        GM_setValue(ONLINE_URL_KEY, url);
        GM_setValue(ONLINE_API_KEY, key);
        if (endpointChanged) {
            GM_setValue(ONLINE_LAST_SYNC_KEY, '');
            GM_setValue(ONLINE_BASELINE_KEY, null);
        }
        updateOnlineStatus('연결 확인 중...');
        onlineRequest('GET', 'ping').then(result => {
            if (!result || result.ok !== true) throw new Error(result?.error || '서버 응답 오류');
            if (Number(result.schemaVersion) !== ONLINE_SCHEMA_VERSION) {
                throw new Error('데이터 형식 버전이 맞지 않습니다.');
            }
            updateOnlineStatus('연결 성공 · 데이터 형식 v' + result.schemaVersion);
            alert('온라인 저장소 연결에 성공했습니다.');
        }).catch(error => {
            updateOnlineStatus('연결 실패');
            alert('온라인 저장소 연결에 실패했습니다.\n\n' + error.message + '\n\nURL과 접속 키를 확인해주세요.');
        });
    }

    function onlineRequest(method, action, body) {
        const config = getOnlineConfig();
        if (!config.url || !config.key) {
            return Promise.reject(new Error('먼저 온라인 연결 설정을 해주세요.'));
        }
        return new Promise((resolve, reject) => {
            const isGet = method === 'GET';
            const url = config.url + '?action=' + encodeURIComponent(action) + '&key=' + encodeURIComponent(config.key);
            GM_xmlhttpRequest({
                method,
                url,
                headers: isGet ? {} : { 'Content-Type': 'application/json' },
                data: isGet ? undefined : JSON.stringify({ ...body, key: config.key }),
                timeout: 30000,
                onload: response => {
                    const responseUrl = response.finalUrl || url;
                    const contentTypeMatch = (response.responseHeaders || '').match(/content-type:\s*([^\r\n]+)/i);
                    const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : '확인 불가';
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error('HTTP 오류: ' + response.status + '\n응답 형식: ' + contentType + '\n최종 주소: ' + responseUrl));
                        return;
                    }
                    try {
                        const result = JSON.parse(response.responseText || '{}');
                        resolve(result);
                    } catch (error) {
                        reject(new Error('서버 응답이 JSON이 아닙니다.\nHTTP 상태: ' + response.status + '\n응답 형식: ' + contentType + '\n최종 주소: ' + responseUrl + '\n원인: ' + error.message));
                    }
                },
                onerror: error => {
                    const details = [
                        '네트워크 요청이 실패했습니다.',
                        '오류 유형: ' + (error?.error || error?.errorType || '확인 불가'),
                        'HTTP 상태: ' + (error?.status ?? '응답 없음'),
                        '브라우저에서 요청 자체가 차단되었거나 연결이 중단되었을 수 있습니다.'
                    ];
                    reject(new Error(details.join('\\n')));
                },
                ontimeout: () => reject(new Error('요청 시간이 초과되었습니다.\\n30초 동안 서버 응답이 없었습니다.'))
            });
        });
    }

    function buildOnlinePackage() {
        savePanelSize();
        saveData();
        const seriesData = {};
        for (const item of seriesMeta.series) {
            const stored = item.id === activeSeriesId
                ? data
                : GM_getValue(seriesStorageKey(item.id), null);
            if (validWatchData(stored)) seriesData[item.id] = cloneData(stored);
            else seriesData[item.id] = { streamers: [], settings: { ...DEFAULT_SETTINGS } };
        }
        return {
            packageVersion: 1,
            activeSeriesId,
            seriesMeta: cloneData(seriesMeta),
            seriesData
        };
    }

    function validateOnlinePackage(pkg) {
        if (!pkg || typeof pkg !== 'object' || pkg.packageVersion !== 1 ||
            !pkg.seriesMeta || !Array.isArray(pkg.seriesMeta.series) ||
            !pkg.seriesData || typeof pkg.seriesData !== 'object') {
            throw new Error('온라인 데이터 패키지 형식이 올바르지 않습니다.');
        }
        if (!pkg.seriesMeta.series.length) throw new Error('온라인 데이터에 시리즈가 없습니다.');
        for (const item of pkg.seriesMeta.series) {
            if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' ||
                !validWatchData(pkg.seriesData[item.id])) {
                throw new Error('온라인 시리즈 데이터가 손상되었거나 누락되었습니다.');
            }
            for (const streamer of pkg.seriesData[item.id].streamers) {
                if (!streamer || typeof streamer.name !== 'string' || !Array.isArray(streamer.entries)) {
                    throw new Error('온라인 스트리머 데이터 형식이 올바르지 않습니다.');
                }
            }
        }
        if (!pkg.seriesMeta.series.some(item => item.id === pkg.activeSeriesId)) {
            throw new Error('온라인 데이터의 활성 시리즈 정보가 올바르지 않습니다.');
        }
        return true;
    }

    function emptyOnlinePackage() {
        return {
            packageVersion: 1,
            activeSeriesId: '',
            seriesMeta: { series: [], activeId: '' },
            seriesData: {}
        };
    }

    function mergeOnlineScalar(remoteValue, baseValue, localValue, hasBase, path, conflicts) {
        const localChanged = !hasBase || !valuesEqual(localValue, baseValue);
        const remoteChanged = !hasBase || !valuesEqual(remoteValue, baseValue);

        if (!localChanged) return cloneData(remoteValue);
        if (!remoteChanged) return cloneData(localValue);
        if (valuesEqual(localValue, remoteValue)) return cloneData(remoteValue);

        // 같은 영상의 진행률은 더 많이 본 값을 보존하고, 완료 상태는 완료를 우선합니다.
        const field = path.split('.').pop();
        if (field === 'watchedSeconds' || field === 'percent') {
            return Math.max(Number(remoteValue) || 0, Number(localValue) || 0);
        }
        if (field === 'completed') return !!remoteValue || !!localValue;

        conflicts.push(path);
        // 같은 항목의 제목/날짜 등 일반 필드가 양쪽에서 다르게 수정된 경우 온라인 값을 우선합니다.
        return cloneData(remoteValue);
    }

    function mergePlainRecord(remoteRecord, baseRecord, localRecord, path, conflicts) {
        const remote = remoteRecord && typeof remoteRecord === 'object' ? remoteRecord : {};
        const base = baseRecord && typeof baseRecord === 'object' ? baseRecord : {};
        const local = localRecord && typeof localRecord === 'object' ? localRecord : {};
        const hasBase = !!baseRecord && typeof baseRecord === 'object';
        const result = {};
        const keys = new Set([...Object.keys(remote), ...Object.keys(base), ...Object.keys(local)]);

        for (const key of keys) {
            if (key === 'entries' || key === 'streamers') continue;
            const rHas = Object.prototype.hasOwnProperty.call(remote, key);
            const bHas = Object.prototype.hasOwnProperty.call(base, key);
            const lHas = Object.prototype.hasOwnProperty.call(local, key);
            const fieldPath = path ? path + '.' + key : key;

            if (!lHas) {
                if (!bHas) {
                    if (rHas) result[key] = cloneData(remote[key]);
                } else if (rHas && !valuesEqual(remote[key], base[key])) {
                    result[key] = cloneData(remote[key]);
                }
                continue;
            }
            if (!rHas) {
                if (!bHas || !valuesEqual(local[key], base[key])) result[key] = cloneData(local[key]);
                continue;
            }

            const bothObjects = remote[key] && local[key] && typeof remote[key] === 'object' && typeof local[key] === 'object' && !Array.isArray(remote[key]) && !Array.isArray(local[key]);
            if (bothObjects) {
                result[key] = mergePlainRecord(remote[key], bHas ? base[key] : null, local[key], fieldPath, conflicts);
            } else {
                result[key] = mergeOnlineScalar(remote[key], base[key], local[key], hasBase && bHas, fieldPath, conflicts);
            }
        }
        return result;
    }

    function mergeKeyedRecords(remoteList, baseList, localList, keyGetter, mergeRecord, path, conflicts) {
        const remote = Array.isArray(remoteList) ? remoteList : [];
        const base = Array.isArray(baseList) ? baseList : [];
        const local = Array.isArray(localList) ? localList : [];
        const result = remote.map(item => cloneData(item));
        const keys = new Set();
        for (const item of [...remote, ...base, ...local]) {
            const key = keyGetter(item);
            if (key) keys.add(key);
        }

        for (const key of keys) {
            const r = remote.find(item => keyGetter(item) === key);
            const b = base.find(item => keyGetter(item) === key);
            const l = local.find(item => keyGetter(item) === key);
            const index = result.findIndex(item => keyGetter(item) === key);

            if (!b) {
                // 기준 스냅샷에 없던 신규 항목은 어느 PC에서 추가했든 합칩니다.
                if (r && l) {
                    const merged = mergeRecord(r, null, l, path + '[' + key + ']', conflicts);
                    if (index >= 0) result[index] = merged;
                } else if (!r && l) {
                    result.push(cloneData(l));
                }
                continue;
            }

            if (!l) {
                // 로컬에서 삭제했더라도 온라인에서 동시에 수정됐다면 온라인 항목을 보존합니다.
                if (r && valuesEqual(r, b)) {
                    const removeIndex = result.findIndex(item => keyGetter(item) === key);
                    if (removeIndex >= 0) result.splice(removeIndex, 1);
                }
                continue;
            }

            if (!r) {
                // 온라인에서 삭제됐지만 로컬에서 기준 이후 수정됐다면 로컬 항목을 살립니다.
                if (!valuesEqual(l, b)) result.push(cloneData(l));
                continue;
            }

            const merged = mergeRecord(r, b, l, path + '[' + key + ']', conflicts);
            const currentIndex = result.findIndex(item => keyGetter(item) === key);
            if (currentIndex >= 0) result[currentIndex] = merged;
        }
        return result;
    }

    function mergeEntryRecord(remoteEntry, baseEntry, localEntry, path, conflicts) {
        return mergePlainRecord(remoteEntry, baseEntry, localEntry, path, conflicts);
    }

    function mergeStreamerRecord(remoteStreamer, baseStreamer, localStreamer, path, conflicts) {
        const merged = mergePlainRecord(remoteStreamer, baseStreamer, localStreamer, path, conflicts);
        merged.entries = mergeKeyedRecords(
            remoteStreamer.entries, baseStreamer && baseStreamer.entries, localStreamer.entries,
            getEntryKey, mergeEntryRecord, path + '.entries', conflicts
        );
        return merged;
    }

    function mergeWatchData(remoteData, baseData, localData, seriesId, conflicts) {
        const remote = validWatchData(remoteData) ? remoteData : { streamers: [], settings: {} };
        const base = validWatchData(baseData) ? baseData : null;
        const local = validWatchData(localData) ? localData : { streamers: [], settings: {} };
        const merged = mergePlainRecord(remote, base, local, 'series.' + seriesId, conflicts);
        merged.streamers = mergeKeyedRecords(
            remote.streamers, base && base.streamers, local.streamers,
            getStreamerKey, mergeStreamerRecord, 'series.' + seriesId + '.streamers', conflicts
        );
        merged.settings = mergePlainRecord(
            remote.settings || {}, base && base.settings, local.settings || {},
            'series.' + seriesId + '.settings', conflicts
        );
        return merged;
    }

    function mergeOnlinePackages(remotePackage, baselinePackage, localPackage) {
        const remote = remotePackage || emptyOnlinePackage();
        const baseline = baselinePackage || emptyOnlinePackage();
        const local = localPackage || emptyOnlinePackage();
        const conflicts = [];
        const mergedMeta = {
            series: mergeKeyedRecords(
                remote.seriesMeta?.series, baseline.seriesMeta?.series, local.seriesMeta?.series,
                item => item && item.id ? item.id : '',
                (r, b, l, path, list) => mergePlainRecord(r, b, l, path, list),
                'seriesMeta.series', conflicts
            )
        };
        if (!mergedMeta.series.length) {
            throw new Error('병합 결과 시리즈가 없습니다. 원본 데이터 보호를 위해 저장을 중단했습니다.');
        }

        const activeBase = baseline.activeSeriesId || baseline.seriesMeta?.activeId || '';
        const activeRemote = remote.activeSeriesId || remote.seriesMeta?.activeId || '';
        const activeLocal = local.activeSeriesId || local.seriesMeta?.activeId || '';
        const activeSeriesId = (!activeRemote && activeLocal)
            ? activeLocal
            : mergeOnlineScalar(
                activeRemote, activeBase, activeLocal, !!activeBase,
                'activeSeriesId', conflicts
            );
        const finalActiveId = mergedMeta.series.some(item => item.id === activeSeriesId)
            ? activeSeriesId : mergedMeta.series[0].id;
        mergedMeta.activeId = finalActiveId;

        const seriesData = {};
        for (const series of mergedMeta.series) {
            const id = series.id;
            seriesData[id] = mergeWatchData(
                remote.seriesData && remote.seriesData[id],
                baseline.seriesData && baseline.seriesData[id],
                local.seriesData && local.seriesData[id],
                id, conflicts
            );
        }

        const result = {
            packageVersion: 1,
            activeSeriesId: finalActiveId,
            seriesMeta: mergedMeta,
            seriesData
        };
        validateOnlinePackage(result);
        return { package: result, conflicts };
    }

    function applyOnlinePackage(pkg) {
        validateOnlinePackage(pkg);
        const incoming = cloneData(pkg);
        seriesMeta = incoming.seriesMeta;
        activeSeriesId = incoming.activeSeriesId;
        GM_setValue(SERIES_META_KEY, seriesMeta);
        for (const item of seriesMeta.series) {
            GM_setValue(seriesStorageKey(item.id), incoming.seriesData[item.id]);
        }
        STORAGE_KEY = seriesStorageKey(activeSeriesId);
        const loaded = GM_getValue(STORAGE_KEY, null);
        if (!validWatchData(loaded)) throw new Error('병합된 데이터의 로컬 저장 검증에 실패했습니다.');
        storageValid = true;
        data = loaded;
        prepareData();
        dataBaseline = cloneData(data);
        currentEntry = null;
        currentStreamer = null;
        currentVideoId = null;
        lastSavedPercent = -1;
        attachedVideo = null;
        expandedCompletedEntries.clear();
        if (panel) {
            const title = document.getElementById('bn-title-text');
            if (title) title.textContent = getActiveSeriesName() + ' 시청 기록';
            applyPanelSize();
            applyPanelPosition();
            applyOpacity();
            findCurrentEntry();
            attachVideoEvents(getVideoElement());
            updatePanel();
        }
    }

    function getRemotePackage(remote) {
        if (!remote || remote.empty || !remote.data) return emptyOnlinePackage();
        validateOnlinePackage(remote.data);
        return remote.data;
    }

    async function syncOnlineData() {
        const config = getOnlineConfig();
        if (!config.url || !config.key) {
            configureOnlineStorage();
            return;
        }
        const button = document.getElementById('bn-online-sync');
        if (button) button.disabled = true;
        updateOnlineStatus('양쪽 기록을 병합하고 동기화 중...');
        try {
            const localPackage = buildOnlinePackage();
            const baselinePackage = GM_getValue(ONLINE_BASELINE_KEY, null);
            let completed = false;
            let finalVerify = null;
            let finalMerge = null;

            // 다른 PC가 거의 동시에 저장한 경우 최신 온라인 데이터를 다시 받아 최대 3회 재시도합니다.
            for (let attempt = 1; attempt <= 3; attempt++) {
                const remote = await onlineRequest('GET', 'load');
                if (!remote || remote.ok !== true) throw new Error(remote?.error || '온라인 데이터를 확인하지 못했습니다.');
                if (Number(remote.schemaVersion) !== ONLINE_SCHEMA_VERSION) throw new Error('데이터 형식 버전이 달라 저장을 중단했습니다.');
                const remotePackage = getRemotePackage(remote);
                const merged = mergeOnlinePackages(remotePackage, baselinePackage, localPackage);

                const result = await onlineRequest('POST', 'save', {
                    action: 'save',
                    schemaVersion: ONLINE_SCHEMA_VERSION,
                    scriptVersion: SCRIPT_VERSION,
                    expectedUpdatedAt: String(remote.updatedAt || ''),
                    data: merged.package
                });
                if (result && result.ok === true) {
                    finalVerify = await onlineRequest('GET', 'load');
                    if (!finalVerify || finalVerify.ok !== true || finalVerify.empty) {
                        throw new Error('저장 후 확인에 실패했습니다. 온라인 데이터를 다시 확인해주세요.');
                    }
                    validateOnlinePackage(finalVerify.data);
                    finalMerge = merged;
                    completed = true;
                    break;
                }
                if (result && result.error === 'REMOTE_CHANGED') continue;
                throw new Error(result?.error || '온라인 저장에 실패했습니다.');
            }
            if (!completed) throw new Error('다른 PC에서 저장이 계속 발생해 병합을 완료하지 못했습니다. 잠시 후 다시 시도해주세요.');

            // 서버에 반영된 최신본을 이 PC에도 적용하고 다음 병합의 기준점으로 저장합니다.
            applyOnlinePackage(finalVerify.data);
            GM_setValue(ONLINE_BASELINE_KEY, cloneData(finalVerify.data));
            GM_setValue(ONLINE_LAST_SYNC_KEY, String(finalVerify.updatedAt || ''));
            updateOnlineSyncTooltip();
            updateOnlineStatus('동기화 완료 · ' + new Date(finalVerify.updatedAt).toLocaleString());
            const conflictMessage = finalMerge.conflicts.length
                ? '\n\n동일한 항목의 일반 정보가 양쪽에서 다르게 수정된 ' + finalMerge.conflicts.length + '개 필드는 온라인 값을 유지했습니다. 시청 진행률은 더 큰 값, 완료 여부는 완료 상태를 보존했습니다.'
                : '';
            alert('동기화가 완료됐습니다.\n\n이 PC와 온라인의 기록을 병합한 뒤, 통합된 전체 기록을 이 PC에도 반영했습니다.\n서로 다른 영상 기록은 모두 보존했습니다.' + conflictMessage);
        } catch (error) {
            updateOnlineStatus('동기화 중단 · ' + error.message);
            alert('온라인 동기화를 중단했습니다.\n\n' + error.message + '\n\n기존 온라인 데이터와 로컬 데이터는 그대로 유지됩니다.');
        } finally {
            if (button) button.disabled = false;
        }
    }

    async function loadOnlineData() {
        const config = getOnlineConfig();
        if (!config.url || !config.key) {
            configureOnlineStorage();
            return;
        }
        const button = document.getElementById('bn-online-load');
        if (button) button.disabled = true;
        updateOnlineStatus('온라인 기록과 이 PC 기록 병합 중...');
        try {
            const remote = await onlineRequest('GET', 'load');
            if (!remote || remote.ok !== true) throw new Error(remote?.error || '온라인 데이터를 불러오지 못했습니다.');
            if (Number(remote.schemaVersion) !== ONLINE_SCHEMA_VERSION) throw new Error('데이터 형식 버전이 달라 병합을 중단했습니다.');
            if (remote.empty || !remote.data) {
                alert('온라인 저장소가 비어 있습니다. 기록이 있는 PC에서 먼저 온라인 저장을 해주세요.');
                updateOnlineStatus('온라인 저장소 비어 있음');
                return;
            }
            validateOnlinePackage(remote.data);

            const localPackage = buildOnlinePackage();
            const baselinePackage = GM_getValue(ONLINE_BASELINE_KEY, null);
            const merged = mergeOnlinePackages(remote.data, baselinePackage, localPackage);
            const ok = confirm(
                '온라인 기록과 이 PC의 기록을 병합할까요?\n\n' +
                '서로 다른 스트리머·영상 기록은 모두 유지됩니다.\n' +
                '같은 영상의 시청 진행률은 더 큰 값, 완료 여부는 완료 상태를 우선합니다.\n' +
                '같은 항목의 제목·날짜 등이 양쪽에서 다르게 수정된 경우 온라인 값을 유지합니다.\n\n' +
                '현재 PC의 데이터는 병합 전에 백업됩니다.'
            );
            if (!ok) return;

            GM_setValue('bongnudo_local_sync_backup_' + Date.now(), localPackage);
            applyOnlinePackage(merged.package);
            // 불러오기는 서버를 덮어쓰지 않습니다. 공통 기준점은 현재 온라인 원본으로 유지합니다.
            GM_setValue(ONLINE_BASELINE_KEY, cloneData(remote.data));
            GM_setValue(ONLINE_LAST_SYNC_KEY, String(remote.updatedAt || ''));
            updateOnlineSyncTooltip();
            updateOnlineStatus('병합 완료 · ' + new Date(remote.updatedAt).toLocaleString());
            const conflictMessage = merged.conflicts.length
                ? '\n\n동일 항목의 일반 정보 충돌 ' + merged.conflicts.length + '건은 온라인 값을 유지했습니다.'
                : '';
            alert('온라인 기록과 이 PC의 기록을 병합했습니다.\n서로 다른 영상 기록은 모두 보존했습니다.' + conflictMessage + '\n\n병합된 로컬 기록을 온라인에도 반영하려면 온라인 저장을 눌러주세요.');
        } catch (error) {
            updateOnlineStatus('병합 불러오기 실패 · ' + error.message);
            alert('온라인 병합 불러오기에 실패했습니다.\n\n' + error.message + '\n\n현재 PC의 기존 데이터는 유지됩니다.');
        } finally {
            if (button) button.disabled = false;
        }
    }

    /************************************************
     * 데이터 내보내기
     ************************************************/

    function exportData() {

        /*
         * 현재 패널 크기/위치까지 저장
         */
        savePanelSize();

        const text =
            JSON.stringify(
                data,
                null,
                4
            );

        const blob =
            new Blob(
                [text],
                {
                    type:
                        'text/plain;charset=utf-8'
                }
            );

        const url =
            URL.createObjectURL(
                blob
            );

        const a =
            document.createElement(
                'a'
            );

        const now =
            new Date();

        const date =
            now.getFullYear() +
            '-' +
            String(
                now.getMonth() + 1
            ).padStart(2, '0') +
            '-' +
            String(
                now.getDate()
            ).padStart(2, '0');

        a.href = url;

        a.download =
            `${getActiveSeriesName().replace(/[\\/:*?"<>|]/g, '_')}_시청기록_${date}.txt`;

        document.body.appendChild(a);

        a.click();

        a.remove();

        URL.revokeObjectURL(url);
    }


    /************************************************
     * 데이터 가져오기
     ************************************************/

    function importData(event) {

        const file =
            event.target.files?.[0];

        if (!file) {
            return;
        }

        const reader =
            new FileReader();

        reader.onload =
            function () {

                try {

                    const imported =
                        JSON.parse(
                            reader.result
                        );

                    if (
                        !imported ||
                        typeof imported !==
                            'object' ||
                        !Array.isArray(
                            imported.streamers
                        )
                    ) {

                        throw new Error(
                            '잘못된 데이터 형식'
                        );
                    }

                    for (
                        const streamer
                        of imported.streamers
                    ) {

                        if (
                            !streamer ||
                            typeof streamer.name !==
                                'string' ||
                            !Array.isArray(
                                streamer.entries
                            )
                        ) {

                            throw new Error(
                                '잘못된 스트리머 데이터'
                            );
                        }

                        for (
                            const entry
                            of streamer.entries
                        ) {

                            if (
                                !entry ||
                                typeof entry !==
                                    'object'
                            ) {

                                throw new Error(
                                    '잘못된 영상 데이터'
                                );
                            }
                        }
                    }

                    const ok =
                        confirm(
                            '현재 저장된 시청 기록을\n' +
                            '가져온 데이터로 교체할까요?'
                        );

                    if (!ok) {
                        return;
                    }

                    data =
                        imported;

                    prepareData();

                    saveData();

                    updatePanel();

                    alert(
                        '시청 기록을 불러왔습니다.'
                    );

                } catch (error) {

                    console.error(
                        error
                    );

                    alert(
                        '가져오기에 실패했습니다.\n\n' +
                        '올바른 시청 기록 파일인지 확인해주세요.'
                    );
                }

                event.target.value = '';
            };

        reader.readAsText(
            file,
            'utf-8'
        );
    }


    /************************************************
     * CSS
     ************************************************/

    GM_addStyle(`

        #bongnudo-watch-panel {

            --bn-scale: 1;
            --bn-opacity: 0.95;

            position: fixed;

            left: auto;
            right: 22px;
            top: 50%;

            width: 430px;
            height: 600px;

            min-width: min(280px, calc(100vw - 12px));
            max-width: min(650px, calc(100vw - 12px));

            min-height: 220px;

            z-index: 2147483647;

            box-sizing: border-box;

            display: flex;
            flex-direction: column;

            overflow: hidden;

            background:
                rgba(
                    20,
                    20,
                    20,
                    var(--bn-opacity)
                );

            color: #fff;

            border:
                calc(1px * var(--bn-scale))
                solid
                rgba(255,255,255,0.16);

            border-radius:
                calc(10px * var(--bn-scale));

            box-shadow:
                0
                calc(5px * var(--bn-scale))
                calc(25px * var(--bn-scale))
                rgba(0,0,0,0.35);

            font-family:
                -apple-system,
                BlinkMacSystemFont,
                "Segoe UI",
                sans-serif;

            font-size:
                calc(13px * var(--bn-scale));

            line-height:
                1.35;

        }


        /* =========================================
           헤더
           ========================================= */

        #bn-header {

            flex: 0 0 auto;

            height:
                calc(42px * var(--bn-scale));

            min-height:
                calc(42px * var(--bn-scale));

            box-sizing: border-box;

            display: flex;

            align-items: center;

            justify-content: space-between;

            padding:
                0
                calc(10px * var(--bn-scale));

            background:
                rgba(
                    35,
                    35,
                    35,
                    var(--bn-opacity)
                );

            border-bottom:
                calc(1px * var(--bn-scale))
                solid
                rgba(255,255,255,0.1);

        }


        #bn-series-modal {
            position: fixed;
            inset: 0;
            z-index: 2147483647;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
            box-sizing: border-box;
            background: rgba(0, 0, 0, 0.58);
            font-family: inherit;
            color: #f5f5f5;
        }

        .bn-series-dialog {
            width: min(360px, 100%);
            max-height: min(520px, 90vh);
            overflow-y: auto;
            box-sizing: border-box;
            padding: 16px;
            border: 1px solid rgba(255,255,255,.16);
            border-radius: 12px;
            background: #252525;
            box-shadow: 0 12px 40px rgba(0,0,0,.45);
        }

        .bn-series-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:16px; margin-bottom:8px; }
        .bn-series-heading button { border:0; border-radius:6px; background:rgba(255,255,255,.1); color:inherit; width:28px; height:28px; cursor:pointer; font-size:20px; }
        .bn-series-description { color:#bdbdbd; font-size:12px; line-height:1.5; margin-bottom:12px; }
        #bn-series-list { display:flex; flex-direction:column; gap:6px; }
        .bn-series-option { display:flex; justify-content:space-between; align-items:center; gap:12px; width:100%; padding:11px 12px; border:1px solid rgba(255,255,255,.12); border-radius:8px; color:#eee; background:rgba(255,255,255,.045); text-align:left; cursor:pointer; }
        .bn-series-option.active { border-color:#78aaff; background:rgba(80,130,220,.18); }
        .bn-series-option-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
        .bn-series-option-status { flex-shrink:0; font-size:11px; color:#aaa; }
        .bn-series-actions { margin-top:12px; }
        #bn-series-add { width:100%; padding:10px; border:1px dashed rgba(255,255,255,.28); border-radius:8px; color:#f5f5f5; background:rgba(255,255,255,.06); cursor:pointer; }

        #bn-drag-handle {

            display: flex;

            align-items: center;

            flex: 1;

            min-width: 0;

            font-size:
                calc(14px * var(--bn-scale));

            font-weight: 700;

            cursor: move;

            user-select: none;

            white-space: nowrap;

            overflow: hidden;

            text-overflow: ellipsis;

            gap: calc(7px * var(--bn-scale));

        }

        #bn-title-text {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        #bn-version-label {
            cursor: pointer;
            flex: 0 0 auto;
            font-size: calc(10px * var(--bn-scale));
            font-weight: 500;
            color: rgba(255,255,255,0.48);
            letter-spacing: 0.15px;
            transform: translateY(1px);
        }


        .bn-header-buttons {

            display: flex;

            align-items: center;

            gap:
                calc(3px * var(--bn-scale));

            flex-shrink: 0;

        }


        .bn-header-buttons button {

            width:
                calc(26px * var(--bn-scale));

            height:
                calc(26px * var(--bn-scale));

            padding: 0;

            border: 0;

            border-radius:
                calc(5px * var(--bn-scale));

            background:
                rgba(
                    255,
                    255,
                    255,
                    0.08
                );

            color: #fff;

            font-size:
                calc(14px * var(--bn-scale));

            cursor: pointer;

        }


        .bn-header-buttons button:hover {

            background:
                rgba(
                    255,
                    255,
                    255,
                    0.18
                );

        }


        /* =========================================
           투명도 / 설정
           ========================================= */

        #bn-opacity-panel,
        #bn-settings-panel {
            flex: 0 0 auto;
            display: flex;
            align-items: center;
            gap: calc(8px * var(--bn-scale));
            padding: calc(8px * var(--bn-scale)) calc(10px * var(--bn-scale));
            background: rgba(25, 25, 25, var(--bn-opacity));
            border-bottom: calc(1px * var(--bn-scale)) solid rgba(255,255,255,0.08);
        }

        #bn-settings-panel.bn-hidden {
            display: none;
        }


        #bn-opacity-panel input {

            flex: 1;

            min-width: 0;

        }


        #bn-opacity-value {

            width:
                calc(40px * var(--bn-scale));

            text-align: right;

            font-size:
                calc(11px * var(--bn-scale));

        }


        #bn-settings-panel {
            flex-direction: column;
            align-items: stretch;
            gap: 0;
        }

        #bn-opacity-panel {
            width: 100%;
            box-sizing: border-box;
        }

        .bn-sort-row,
        .bn-data-row {
            display: flex;
            align-items: center;
            gap: calc(6px * var(--bn-scale));
        }

        .bn-online-row {
            margin-top: calc(10px * var(--bn-scale));
        }
        .bn-online-row button {
            flex: 1 1 0;
            min-width: 0;
            white-space: nowrap;
            font-size: calc(10px * var(--bn-scale));
        }
        .bn-online-status {
            padding: 2px 4px 5px;
            color: rgba(255,255,255,.68);
            font-size: calc(10px * var(--bn-scale));
            overflow-wrap: anywhere;
        }
        .bn-online-row button:disabled {
            opacity: .55;
            cursor: wait;
        }

        .bn-view-mode-bar {
            display: flex;
            align-items: center;
            gap: calc(8px * var(--bn-scale));
            padding: calc(4px * var(--bn-scale)) calc(8px * var(--bn-scale));
            flex: 0 0 auto;
            background: rgba(20,20,20,calc(var(--bn-opacity) * 0.7));
        }
        .bn-view-mode-bar > span {
            flex: 0 0 auto;
            font-size: calc(11px * var(--bn-scale));
            opacity: .85;
        }

        #bn-view-mode {
            flex: 1;
            min-width: 0;
            height: calc(30px * var(--bn-scale));
            border: 0;
            border-radius: calc(5px * var(--bn-scale));
            background: rgba(255,255,255,0.08);
            color: #fff;
            font-size: calc(11px * var(--bn-scale));
        }

        #bn-view-mode option {
            background: #252525;
            color: #fff;
        }

        #bn-order-edit {
            flex: 0 0 auto !important;
            min-width: calc(62px * var(--bn-scale)) !important;
        }

        #bn-settings-panel button {

            flex: 1;

            min-width: 0;

            height:
                calc(30px * var(--bn-scale));

            border: 0;

            border-radius:
                calc(5px * var(--bn-scale));

            background:
                rgba(
                    255,
                    255,
                    255,
                    0.08
                );

            color: #fff;

            font-size:
                calc(12px * var(--bn-scale));

            cursor: pointer;

        }


        /* =========================================
           본문
           ========================================= */

        #bn-body {

            flex: 1 1 auto;

            min-height: 0;

            display: flex;

            flex-direction: column;

            overflow: hidden;

        }


        #bn-current {

            flex: 0 0 auto;

            margin:
                calc(8px * var(--bn-scale));

            padding:
                calc(10px * var(--bn-scale));

            box-sizing: border-box;

            border-radius:
                calc(7px * var(--bn-scale));

            background: linear-gradient(
                90deg,
                rgba(45, 45, 45, var(--bn-opacity)) 0%,
                rgba(45, 45, 45, calc(var(--bn-opacity) - 0.15)) 50%,
                rgba(45, 45, 45, var(--bn-opacity)) 100%
            );

        }


        .bn-current-title {

            font-size:
                calc(10px * var(--bn-scale));

            opacity: 0.7;

            margin-bottom:
                calc(4px * var(--bn-scale));

        }


        .bn-current-name {

            font-size:
                calc(16px * var(--bn-scale));

            font-weight: 600;
            text-align: center;

            overflow: hidden;

            white-space: nowrap;

            text-overflow: ellipsis;

        }


        .bn-current-none {

            font-size:
                calc(12px * var(--bn-scale));

            opacity: 0.65;

        }

        .bn-current-controls {
            display: flex;
            width: 60%;
            margin: calc(8px * var(--bn-scale)) auto 0;
            gap: calc(4px * var(--bn-scale));
        }

        .bn-current-control {
            flex: 1 1 0;
            min-width: 0;
            padding: calc(7px * var(--bn-scale)) calc(4px * var(--bn-scale));
            border: 0;
            border-radius: calc(4px * var(--bn-scale));
            background: rgba(255,255,255,0.10);
            color: #fff;
            font-size: calc(17px * var(--bn-scale));
            line-height: 1.1;
            cursor: pointer;
        }

        .bn-current-control:hover:not(:disabled) {
            background: rgba(255,255,255,0.20);
        }

        .bn-current-control:disabled,
        .bn-current-control.bn-boundary-disabled {
            opacity: 0.35;
            cursor: not-allowed;
        }

        .bn-current-control.bn-boundary-disabled:hover {
            background: rgba(255,255,255,0.10);
        }

        .bn-last-watched {
            margin-top: calc(8px * var(--bn-scale));
            padding-top: calc(7px * var(--bn-scale));
            border-top: 1px solid rgba(255,255,255,0.10);
        }

        .bn-last-label {
            font-size: calc(10px * var(--bn-scale));
            opacity: 0.7;
            margin-bottom: calc(3px * var(--bn-scale));
        }

        .bn-last-actions {
            display: flex;
            gap: calc(6px * var(--bn-scale));
            margin-top: calc(5px * var(--bn-scale));
        }

        .bn-last-actions .bn-current-control {
            flex: 1;
            min-width: 0;
            margin-top: 0;
        }

        .bn-progress,
        .bn-entry-progress {

            height:
                calc(6px * var(--bn-scale));

            margin-top:
                calc(8px * var(--bn-scale));

            border-radius:
                calc(3px * var(--bn-scale));

            overflow: hidden;

            background:
                rgba(
                    255,
                    255,
                    255,
                    0.1
                );

        }


        .bn-progress-bar,
        .bn-entry-progress-bar {

            height: 100%;

            background:
                rgba(
                    90,
                    180,
                    255,
                    0.9
                );

            transition:
                width 0.2s ease;

        }


        .bn-chzzk-current-status {

            margin-top:
                calc(6px * var(--bn-scale));

            font-size:
                calc(12px * var(--bn-scale));

        }


        /* =========================================
           스트리머 목록
           ========================================= */

        .bn-streamer-page-nav {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin: 4px 0 8px;
        }
        .bn-streamer-page-nav button {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 3px;
            min-width: 38px;
            height: 30px;
            font-size: 20px;
            line-height: 1;
            cursor: pointer;
        }
        .bn-streamer-page-nav button small {
            font-size: 10px;
            opacity: .75;
        }
        .bn-streamer-page-nav span {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            text-align: center;
            opacity: .9;
            font-size: 12px;
        }
        #bn-streamers.bn-page-mode { overflow-y: auto; }

        #bn-streamers {

            flex: 1 1 auto;

            min-height: 0;

            overflow-y: auto;

            padding:
                0
                calc(8px * var(--bn-scale));

        }


        #bn-streamers::-webkit-scrollbar {

            width:
                calc(6px * var(--bn-scale));

        }


        #bn-streamers::-webkit-scrollbar-thumb {

            background:
                rgba(255,255,255,0.18);

            border-radius: 10px;

        }


        .bn-streamer {

            margin-bottom:
                calc(6px * var(--bn-scale));

            border-radius:
                calc(7px * var(--bn-scale));

            overflow: hidden;

            /* 스트리머 컨테이너를 청회색 계열로 구분 */
            background:
                rgba(
                    48,
                    54,
                    64,
                    var(--bn-opacity)
                );

            /* 컨테이너 경계를 얇게 표시 */
            border:
                1px solid
                rgba(
                    120,
                    135,
                    155,
                    calc(var(--bn-opacity) * 0.55)
                );

            box-sizing: border-box;
        }


        .bn-streamer-header {

            min-height:
                calc(38px * var(--bn-scale));

            display: flex;

            align-items: center;

            justify-content: space-between;

            gap:
                calc(5px * var(--bn-scale));

            padding:
                calc(5px * var(--bn-scale))
                calc(7px * var(--bn-scale));

            box-sizing: border-box;

        }


        .bn-streamer-title {

            flex: 1;

            min-width: 0;

            display: flex;

            align-items: center;

            gap:
                calc(5px * var(--bn-scale));

            font-size:
                calc(13px * var(--bn-scale));

            font-weight: 600;

            cursor: pointer;

            overflow: hidden;

        }


        .bn-streamer-title span:last-child {

            overflow: hidden;

            white-space: nowrap;

            text-overflow: ellipsis;

        }

        .bn-streamer-name-completed {
            color: #e8d89a;
        }


        .bn-arrow {

            flex-shrink: 0;

            width:
                calc(12px * var(--bn-scale));

            font-size:
                calc(9px * var(--bn-scale));

            opacity: 0.65;

        }


        #bn-streamers.bn-order-edit .bn-streamer {
            outline: calc(1px * var(--bn-scale)) solid rgba(255,255,255,0.10);
        }

        .bn-streamer-buttons {

            display: flex;

            align-items: center;

            gap:
                calc(3px * var(--bn-scale));

            flex-shrink: 0;

        }


        .bn-small-button {

            height:
                calc(25px * var(--bn-scale));

            min-width:
                calc(25px * var(--bn-scale));

            padding:
                0
                calc(6px * var(--bn-scale));

            border: 0;

            border-radius:
                calc(4px * var(--bn-scale));

            background:
                rgba(
                    255,
                    255,
                    255,
                    0.08
                );

            color: #fff;

            font-size:
                calc(10px * var(--bn-scale));

            cursor: pointer;

            white-space: nowrap;

        }


        .bn-small-button:hover {

            background:
                rgba(
                    255,
                    255,
                    255,
                    0.18
                );

        }


        .bn-entries {

            padding:
                0
                calc(6px * var(--bn-scale))
                calc(6px * var(--bn-scale));

            /* 긴 회차 목록은 스트리머별로 내부 스크롤 */
            max-height:
                min(52vh, calc(600px * var(--bn-scale)));

            overflow-y: auto;
            overflow-x: hidden;

            /* 내부 목록 끝에서는 휠을 바깥 전체 목록으로 넘김 */
            overscroll-behavior-y: auto;
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.22) transparent;

            box-sizing: border-box;

        }

        .bn-entries::-webkit-scrollbar {
            width: calc(5px * var(--bn-scale));
        }

        .bn-entries::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.22);
            border-radius: 10px;
        }

        .bn-entries::-webkit-scrollbar-thumb:hover {
            background: rgba(255,255,255,0.36);
        }

        .bn-entries-resize-handle {
            height: calc(8px * var(--bn-scale));
            min-height: 6px;
            margin: 0 calc(6px * var(--bn-scale)) calc(3px * var(--bn-scale));
            border-radius: 4px;
            cursor: ns-resize;
            touch-action: none;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: .55;
            user-select: none;
        }

        .bn-entries-resize-handle::after {
            content: '';
            width: 34px;
            height: 3px;
            border-top: 1px solid rgba(255,255,255,.7);
            border-bottom: 1px solid rgba(255,255,255,.7);
            border-radius: 2px;
        }

        .bn-entries-resize-handle:hover,
        .bn-entries-resize-handle.bn-resizing {
            background: rgba(255,255,255,.10);
            opacity: 1;
        }

        .bn-entry {

            padding:
                calc(7px * var(--bn-scale));

            margin-top:
                calc(4px * var(--bn-scale));

            border-radius:
                calc(5px * var(--bn-scale));

            background:
                rgba(
                    20,
                    20,
                    20,
                    var(--bn-opacity)
                );

        }


        .bn-entry-main {

            display: flex;

            align-items: center;

            justify-content: space-between;

            gap:
                calc(5px * var(--bn-scale));

        }



        .bn-entry {
            position: relative;
        }

        .bn-entry-fold {
            flex: 0 0 auto;
            width: calc(25px * var(--bn-scale));
            height: calc(23px * var(--bn-scale));
            padding: 0;
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: calc(4px * var(--bn-scale));
            background: rgba(255,255,255,0.06);
            color: rgba(255,255,255,0.82);
            font-size: calc(18px * var(--bn-scale));
            line-height: 1;
            cursor: pointer;
        }

        .bn-entry-fold:hover {
            background: rgba(255,255,255,0.14);
        }

        .bn-entry-collapsed {
            padding: calc(5px * var(--bn-scale)) calc(7px * var(--bn-scale));
        }

        .bn-entry-collapsed .bn-entry-main {
            min-height: calc(22px * var(--bn-scale));
        }

        .bn-entry-collapsed .bn-entry-progress,
        .bn-entry-collapsed .bn-entry-buttons,
        .bn-entry-collapsed .bn-entry-date,
        .bn-entry-collapsed .bn-entry-status {
            display: none !important;
        }

        .bn-entry-date {
            position: absolute;
            right: calc(8px * var(--bn-scale));
            bottom: calc(6px * var(--bn-scale));
            width: calc(72px * var(--bn-scale));
            height: calc(22px * var(--bn-scale));
            box-sizing: border-box;
            padding: calc(2px * var(--bn-scale)) calc(5px * var(--bn-scale));
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: calc(4px * var(--bn-scale));
            background: rgba(0, 0, 0, 0.30);
            color: rgba(255, 255, 255, 0.65);
            font-size: calc(11px * var(--bn-scale));
            line-height: calc(16px * var(--bn-scale));
            text-align: center;
            outline: none;
        }

        .bn-entry-date::placeholder {
            color: rgba(255, 255, 255, 0.35);
        }

        .bn-entry-date:focus {
            background: rgba(0, 0, 0, 0.42);
            color: rgba(255, 255, 255, 0.9);
            border-color: rgba(255, 255, 255, 0.25);
        }

        .bn-entry-title {

            min-width: 0;

            flex: 1;

            font-size:
                calc(14px * var(--bn-scale));

            font-weight: 500;

            overflow: hidden;

            white-space: nowrap;

            text-overflow: ellipsis;

        }

        .bn-entry-title-completed {
            color: #e8d89a;
        }


        .bn-entry-status {

            flex-shrink: 0;

            font-size:
                calc(10px * var(--bn-scale));

            opacity: 0.75;

        }


        .bn-entry-buttons {

            display: flex;

            flex-wrap: wrap;

            gap:
                calc(3px * var(--bn-scale));

            margin-top:
                calc(6px * var(--bn-scale));

        }


        .bn-no-entry,
        .bn-empty {

            padding:
                calc(10px * var(--bn-scale));

            font-size:
                calc(11px * var(--bn-scale));

            opacity: 0.55;

            text-align: center;

        }


        /* =========================================
           하단 버튼
           ========================================= */

        #bn-buttons {

            flex: 0 0 auto;

            display: flex;

            gap:
                calc(6px * var(--bn-scale));

            padding:
                calc(8px * var(--bn-scale));

            border-top:
                calc(1px * var(--bn-scale))
                solid
                rgba(255,255,255,0.08);

            background:
                rgba(
                    25,
                    25,
                    25,
                    var(--bn-opacity)
                );

        }


        #bn-buttons button {

            flex: 1;

            min-width: 0;

            height:
                calc(34px * var(--bn-scale));

            border: 0;

            border-radius:
                calc(6px * var(--bn-scale));

            background:
                rgba(
                    255,
                    255,
                    255,
                    0.09
                );

            color: #fff;

            font-size:
                calc(11px * var(--bn-scale));

            cursor: pointer;

        }


        #bn-buttons button:hover {

            background:
                rgba(
                    255,
                    255,
                    255,
                    0.17
                );

        }


        /* =========================================
           다시 열기 버튼
           ========================================= */

        #bn-reopen {

            position: fixed;

            right: 20px;

            top: 80px;

            z-index: 2147483647;

            height: 36px;

            padding:
                0 12px;

            border: 0;

            border-radius: 8px;

            background:
                rgba(
                    25,
                    25,
                    25,
                    0.95
                );

            color: #fff;

            font-size: 12px;

            cursor: pointer;

            box-shadow:
                0 4px 15px
                rgba(0,0,0,0.3);

        }


        #bn-reopen:hover {

            background:
                rgba(
                    50,
                    50,
                    50,
                    0.95
                );

        }


        /* =========================================
           리사이즈 핸들
           ========================================= */

        .bn-resize-handle {

            position: absolute;

            z-index: 20;

        }


        .bn-resize-left,
        .bn-resize-right {

            top: 8px;

            bottom: 8px;

            width: 6px;

            cursor: ew-resize;

        }


        .bn-resize-left {

            left: -3px;

        }


        .bn-resize-right {

            right: -3px;

        }


        .bn-resize-top,
        .bn-resize-bottom {

            left: 8px;

            right: 8px;

            height: 6px;

            cursor: ns-resize;

        }


        .bn-resize-top {

            top: -3px;

        }


        .bn-resize-bottom {

            bottom: -3px;

        }


        /* =========================================
           모서리
           ========================================= */

        .bn-resize-corner {

            position: absolute;

            z-index: 30;

            width: 12px;

            height: 12px;

        }


        .bn-corner-tl {

            left: -3px;

            top: -3px;

            cursor: nwse-resize;

        }


        .bn-corner-tr {

            right: -3px;

            top: -3px;

            cursor: nesw-resize;

        }


        .bn-corner-bl {

            left: -3px;

            bottom: -3px;

            cursor: nesw-resize;

        }


        .bn-corner-br {

            right: -3px;

            bottom: -3px;

            cursor: nwse-resize;

        }


        /* =========================================
           스트리머 수정 / 일괄 추가 모달
           ========================================= */

        .bn-modal-overlay {

            position: fixed;

            inset: 0;

            z-index: 2147483646;

            display: flex;

            align-items: center;

            justify-content: center;

            padding: 20px;

            background: rgba(0,0,0,0.45);

            box-sizing: border-box;

        }

        .bn-modal {

            width: min(760px, 92vw);

            max-height: 86vh;

            display: flex;

            flex-direction: column;

            overflow: hidden;

            border: 1px solid rgba(255,255,255,0.14);

            border-radius: 9px;

            background: #24272d;

            color: #fff;

            box-shadow: 0 14px 45px rgba(0,0,0,0.45);

            font-family: inherit;

        }

        .bn-modal-header {

            flex: 0 0 auto;

            display: flex;

            align-items: center;

            justify-content: space-between;

            padding: 11px 13px;

            border-bottom: 1px solid rgba(255,255,255,0.10);

            font-size: 14px;

            font-weight: 600;

        }

        .bn-modal-close {

            width: 28px;

            height: 28px;

            border: 0;

            border-radius: 5px;

            background: rgba(255,255,255,0.08);

            color: #fff;

            font-size: 18px;

            cursor: pointer;

        }

        .bn-modal-content {

            min-height: 0;

            overflow: auto;

        }

        .bn-modal-body {

            padding: 13px;

        }

        .bn-modal-label {

            display: block;

            margin: 0 0 5px;

            font-size: 11px;

            opacity: 0.75;

        }

        .bn-modal-input {

            width: 100%;

            height: 34px;

            box-sizing: border-box;

            padding: 0 9px;

            margin-bottom: 10px;

            border: 1px solid rgba(255,255,255,0.12);

            border-radius: 5px;

            outline: none;

            background: rgba(0,0,0,0.28);

            color: #fff;

            font-size: 12px;

        }

        .bn-modal-input:focus {

            border-color: rgba(255,255,255,0.28);

        }

        .bn-modal-actions {

            display: flex;

            gap: 6px;

            justify-content: flex-end;

            margin-top: 5px;

        }

        .bn-modal-button,
        .bn-modal-danger {

            min-height: 31px;

            padding: 0 10px;

            border: 0;

            border-radius: 5px;

            background: rgba(255,255,255,0.09);

            color: #fff;

            font-size: 11px;

            cursor: pointer;

        }

        .bn-modal-button:hover {

            background: rgba(255,255,255,0.16);

        }

        .bn-modal-button:disabled {

            opacity: 0.45;

            cursor: wait;

        }

        .bn-modal-danger-row {

            margin-top: 16px;

            padding-top: 12px;

            border-top: 1px solid rgba(255,255,255,0.08);

        }

        .bn-modal-danger {

            background: rgba(180,50,50,0.24);

        }

        .bn-modal-danger:hover {

            background: rgba(200,60,60,0.36);

        }

        .bn-bulk-help {

            margin-bottom: 12px;

            padding: 8px;

            border-radius: 5px;

            background: rgba(255,255,255,0.05);

            color: rgba(255,255,255,0.72);

            font-size: 11px;

            line-height: 1.5;

        }

        .bn-bulk-link-row {
            display: flex;
            gap: 6px;
            align-items: center;
        }

        .bn-bulk-link-row .bn-modal-input {
            flex: 1;
            min-width: 0;
        }

        .bn-bulk-save-link {
            flex: 0 0 auto;
            white-space: nowrap;
        }

        .bn-bulk-date-row {

            display: grid;

            grid-template-columns: 1fr 1fr;

            gap: 8px;

        }

        .bn-bulk-date-row .bn-modal-input {

            width: 100%;

        }

        .bn-bulk-load {

            margin-right: auto;

        }

        .bn-bulk-status {

            margin-top: 10px;

            padding: 7px 8px;

            border-radius: 5px;

            background: rgba(0,0,0,0.18);

            color: rgba(255,255,255,0.70);

            font-size: 11px;

        }

        .bn-bulk-list {

            margin-top: 10px;

            border: 1px solid rgba(255,255,255,0.10);

            border-radius: 6px;

            overflow: hidden;

        }

        .bn-bulk-list-header {

            display: flex;

            align-items: center;

            justify-content: space-between;

            padding: 8px;

            background: rgba(255,255,255,0.06);

            font-size: 11px;

        }

        .bn-bulk-list-header label {

            display: flex;

            align-items: center;

            gap: 5px;

            cursor: pointer;

        }

        .bn-bulk-item {

            display: grid;

            grid-template-columns: 28px 58px 68px minmax(0, 1fr) auto;

            align-items: center;

            gap: 6px;

            padding: 7px 8px;

            border-top: 1px solid rgba(255,255,255,0.06);

            font-size: 11px;

        }

        .bn-bulk-item:hover {

            background: rgba(255,255,255,0.04);

        }

        .bn-bulk-check-wrap {

            display: flex;

            justify-content: center;

        }

        .bn-bulk-date {

            color: rgba(255,255,255,0.70);

            white-space: nowrap;

        }

        .bn-bulk-day {

            width: 100%;

            height: 26px;

            box-sizing: border-box;

            padding: 0 5px;

            border: 1px solid rgba(255,255,255,0.10);

            border-radius: 4px;

            outline: none;

            background: rgba(0,0,0,0.20);

            color: #fff;

            font-size: 10px;

        }

        .bn-bulk-title-input {

            min-width: 0;

            flex: 1;

            box-sizing: border-box;

            min-height: 26px;

            padding: 4px 6px;

            border: 1px solid rgba(255,255,255,0.10);

            border-radius: 4px;

            outline: none;

            background: rgba(0,0,0,0.18);

            color: #fff;

            font-size: 11px;

        }

        .bn-bulk-title-input:focus {
            border-color: rgba(255,255,255,0.25);
            background: rgba(0,0,0,0.28);
        }

        .bn-bulk-title-input::placeholder {
            color: rgba(255,255,255,0.35);
        }

        .bn-bulk-duplicate {

            padding: 3px 5px;

            border-radius: 4px;

            background: rgba(255,255,255,0.07);

            color: rgba(255,255,255,0.45);

            white-space: nowrap;

            font-size: 9px;

        }

        .bn-bulk-duplicate-row {

            opacity: 0.55;

        }

        .bn-bulk-confirm-row {

            display: flex;

            align-items: center;

            justify-content: flex-end;

            gap: 8px;

            padding: 8px;

            border-top: 1px solid rgba(255,255,255,0.08);

            background: rgba(255,255,255,0.03);

        }

        .bn-bulk-selected-count {

            margin-right: auto;

            color: rgba(255,255,255,0.62);

            font-size: 10px;

        }

    `);


    /************************************************
     * 페이지 변화 감지
     ************************************************/

    function checkPageChange() {

        if (
            location.href !== lastUrl
        ) {

            lastUrl =
                location.href;

            currentEntry = null;
            currentStreamer = null;
            currentVideoId = null;

            attachedVideo = null;
            lastSavedPercent = -1;

            setTimeout(
                () => {

                    findCurrentEntry();

                    const video =
                        getVideoElement();

                    attachVideoEvents(
                        video
                    );

                    updatePanel();

                },
                1000
            );
        }
    }


    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('pageshow', handleViewportChange);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            handleViewportChange();
        }
    });


    /************************************************
     * 초기화
     ************************************************/

    function initialize() {

        /*
         * 패널 닫힘 상태라면
         * 패널을 만든 뒤 숨깁니다.
         */
        createPanel();
        checkLatestScriptVersion();

        if (
            data.settings.panelClosed
        ) {

            panel.style.display =
                'none';

            createReopenButton();
        }

        /*
         * 저장된 접힘 상태를 복원합니다.
         * 초기화 과정에서는 저장하지 않습니다.
         */
        if (data.settings.panelCollapsed === true) {
            applyPanelCollapsed();
        } else {
            data.settings.panelCollapsed = false;
            applyPanelCollapsed();
        }

        /*
         * 현재 영상 찾기
         */
        findCurrentEntry();

        /*
         * 비디오 연결
         */
        const video =
            getVideoElement();

        attachVideoEvents(
            video
        );

        /*
         * SPA 페이지 변화 감지
         */
        setInterval(
            checkPageChange,
            1000
        );

        /*
         * 비디오가 늦게 생기는 경우
         */
        setInterval(
            () => {

                const currentVideo =
                    getVideoElement();

                if (
                    currentVideo &&
                    currentVideo !==
                        attachedVideo
                ) {

                    attachedVideo =
                        null;

                    attachVideoEvents(
                        currentVideo
                    );
                }

                findCurrentEntry();

            },
            1500
        );
    }


    /************************************************
     * 메뉴
     ************************************************/

    GM_registerMenuCommand(
        '시청 기록 패널 열기',
        openPanel
    );

    /*
     * 저장 데이터 진단 - 읽기 전용
     * 이 메뉴는 저장값을 변경하지 않습니다.
     */
    GM_registerMenuCommand(
        '현재 시리즈 저장 데이터 진단',
        () => {
            const raw = GM_getValue(STORAGE_KEY, null);

            if (
                raw &&
                typeof raw === 'object' &&
                Array.isArray(raw.streamers)
            ) {
                const entryCount =
                    raw.streamers.reduce(
                        (sum, s) =>
                            sum +
                            (Array.isArray(s.entries)
                                ? s.entries.length
                                : 0),
                        0
                    );

                alert(
                    `저장 데이터 정상 (${getActiveSeriesName()})\n\n` +
                    `스트리머: ${raw.streamers.length}명\n` +
                    `영상: ${entryCount}개\n` +
                    `패널 접힘: ${raw.settings?.panelCollapsed === true ? '예' : '아니오'}`
                );
            } else {
                alert(
                    '저장 데이터가 없거나 형식이 올바르지 않습니다.'
                );
            }
        }
    );

    GM_registerMenuCommand(
        '현재 시리즈 시청 기록 내보내기',
        exportData
    );

    GM_registerMenuCommand('온라인 저장소 연결 설정', configureOnlineStorage);
    GM_registerMenuCommand('온라인 시청 기록 동기화', syncOnlineData);


    /************************************************
     * 시작
     ************************************************/

    if (
        document.readyState ===
        'loading'
    ) {

        document.addEventListener(
            'DOMContentLoaded',
            initialize
        );

    } else {

        initialize();
    }

})();
