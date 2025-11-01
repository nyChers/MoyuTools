// ==UserScript==
// @name         MYTools-猫猫放置-插件基础
// @namespace    https://github.com/nyChers/MoyuTools
// @version      1.0.14
// @description  为猫猫放置游戏提供统一的 WebSocket 拦截和消息处理基础封装
// @author       miaoaim over Lingma
// @downloadURL  https://github.com/nyChers/MoyuTools/blob/master/MYTools-%E7%8C%AB%E7%8C%AB%E6%94%BE%E7%BD%AE-%E6%8F%92%E4%BB%B6%E5%9F%BA%E7%A1%80.js
// @match        *://*moyu-idle.com/*
// @match        *://www.moyu-idle.com/*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js
// @run-at       document-start
// ==/UserScript==
// 参考 妙妙小工具等 by 火龙果 实现ws解析

(function () {
    'use strict';

    // 调试配置
    const DEBUG_CONFIG = {
        // 是否启用调试模式
        enabled: GM_getValue('mytools_debug_enabled', false),
        // 过滤器配置 - 使用正则表达式匹配消息类型
        sendFilters: GM_getValue('mytools_debug_sendFilters', []),    // 发送消息过滤器（正则表达式）
        receiveFilters: GM_getValue('mytools_debug_receiveFilters', [])  // 接收消息过滤器（正则表达式）
    };

    // UI配置
    const UI_CONFIG = {
        buttonPosition: {
            x: GM_getValue('mytools_button_x', 20),
            y: GM_getValue('mytools_button_y', 20)
        },
        panelPosition: {
            x: GM_getValue('mytools_panel_x', 70),
            y: GM_getValue('mytools_panel_y', 20)
        },
        panelMinimized: GM_getValue('mytools_panel_minimized', true),
    };

    // 插件面板位置配置
    const PLUGIN_PANEL_CONFIG = GM_getValue('mytools_plugin_panel_config', {}); // 保存各插件面板位置、类型和打开状态
    console.debug('[MYTools] 子插件面板配置: ', PLUGIN_PANEL_CONFIG)

    // 全局 WebSocket 实例引用
    let currentSocket = null;
    let userInfo = null;
    let lastMessageType = null; // 存储上一条消息的类型

    let isWSReady = false;
    let isUIReady = false;

    // 消息状态管理
    let messageStatus = {
        title: '',
        waiting: false,
        next: false
    };

    // 消息处理器注册表
    const messageHandlers = new Map(); // 使用Map替代普通对象，支持复杂键值

    // 发送消息处理器注册表
    const sendMessageHandlers = new Map();

    // 活跃连接管理
    const activeSockets = new Set();

    // UI元素引用
    let floatingButton = null;
    let configPanel = null;
    let pluginIconPanel = null; // 新增插件图标面板引用

    let isDragging = false;
    let hasMoved = false;

    // 插件注册表
    const registeredPlugins = [];

    // 插件面板注册表
    const registeredPanels = new Map();

    // 插件状态栏注册表
    const registeredStatusBarItems = new Map();

    // 判断当前对象是否为真正的WebSocket实例
    function isRealWebSocket(obj) {
        // 双重校验：类型和构造函数，避免原型链污染导致的误判
        return obj instanceof WebSocket &&
            obj.constructor === WebSocket &&
            !activeSockets.has(obj); // 避免重复处理
    }

    // 解析 Socket.IO 格式消息
    function parseSocketIOMessage(messageData) {
        try {
            // 处理 Socket.IO 格式消息 (数字-JSON 格式，如 "451-[...]")
            if (typeof messageData === 'string') {
                // 检查是否为 Socket.IO 格式 (数字-JSON)
                const socketIORegex = /^\d+-(.*)$/;
                const match = messageData.match(socketIORegex);

                if (match) {
                    // 提取 JSON 部分
                    const jsonPart = match[1];
                    return JSON.parse(jsonPart);
                }

                // 处理标准 Socket.IO 格式 (42 开头)
                if (messageData.startsWith('42')) {
                    const jsonPart = messageData.substring(2);
                    return JSON.parse(jsonPart);
                }
            }

            // 处理标准 JSON
            return JSON.parse(messageData);
        } catch (e) {
            // 解析失败时返回原始数据
            return messageData;
        }
    }

    // 检查消息类型是否匹配过滤器（支持正则表达式）
    function isMessageTypeMatch(messageType, filters) {
        if (!messageType || filters.length === 0) return true;

        return filters.some(filter => {
            try {
                const regex = new RegExp(filter);
                return regex.test(messageType);
            } catch (e) {
                // 如果不是有效正则表达式，当作普通字符串匹配
                return messageType.includes(filter);
            }
        });
    }

    // WebSocket 拦截器初始化
    function initWebSocketInterceptor() {
        console.log('[MYTools] 初始化拦截器...');

        const wsProto = WebSocket.prototype;

        // 拦截 send 方法
        const originalSend = wsProto.send;
        wsProto.send = function (data) {
            // 非WebSocket实例直接放行
            if (!isRealWebSocket(this)) {
                return originalSend.apply(this, arguments);
            }

            // 处理发送消息调试打印
            handleSendDebugLogging(data);

            currentSocket = this;
            handleOutgoingMessage(data);
            return originalSend.apply(this, arguments);
        };

        // 拦截 onmessage 属性
        const onmessageDescriptor = Object.getOwnPropertyDescriptor(wsProto, 'onmessage');
        if (onmessageDescriptor) {
            Object.defineProperty(wsProto, 'onmessage', {
                ...onmessageDescriptor,
                set: function (callback) {
                    // 非WebSocket实例直接放行
                    if (!isRealWebSocket(this)) {
                        return onmessageDescriptor.set.call(this, callback);
                    }

                    const wsInstance = this;
                    currentSocket = this;
                    const wrappedCallback = (event) => {
                        handleIncomingMessage(event.data, wsInstance);
                        if (typeof callback === 'function') {
                            callback.call(wsInstance, event);
                        }
                    };
                    onmessageDescriptor.set.call(this, wrappedCallback);
                }
            });
        }

        isWSReady = true;
        console.log('[MYTools] 拦截器部署完成');
    }

    // 处理发送消息调试打印
    function handleSendDebugLogging(data) {
        if (!DEBUG_CONFIG.enabled) return;

        let shouldLog = DEBUG_CONFIG.sendFilters.length === 0; // 默认打印所有
        let messageType = null;

        try {
            if (typeof data === 'string') {
                // 尝试解析消息类型
                if (data.startsWith('42')) {
                    const payload = JSON.parse(data.substring(2));
                    messageType = payload[0];
                } else {
                    const payload = JSON.parse(data);
                    messageType = Array.isArray(payload) ? payload[0] : null;
                }

                // 检查是否匹配过滤器（使用正则匹配）
                if (DEBUG_CONFIG.sendFilters.length > 0) {
                    shouldLog = isMessageTypeMatch(messageType, DEBUG_CONFIG.sendFilters);
                }

                if (shouldLog) {
                    console.log('%c[MYTools WS发送]', 'color: #03A9F4; font-weight: bold;',
                        messageType ? `(类型: ${messageType})` : '', data);
                }
            } else if (data instanceof ArrayBuffer) {
                // 二进制数据
                if (DEBUG_CONFIG.sendFilters.length === 0) { // 只在无过滤器时打印
                    console.log('%c[MYTools WS发送]', 'color: #03A9F4; font-weight: bold;',
                        '(二进制数据)', data);
                }
            }
        } catch (e) {
            // 解析失败时仍然可以打印原始数据
            if (DEBUG_CONFIG.sendFilters.length === 0) {
                console.log('%c[MYTools WS发送]', 'color: #03A9F4; font-weight: bold;',
                    '(无法解析)', data);
            }
        }
    }

    // 处理接收消息调试打印
    function handleReceiveDebugLogging(messageData, parsedData, messageType) {
        if (!DEBUG_CONFIG.enabled) return;

        let shouldLog = DEBUG_CONFIG.receiveFilters.length === 0; // 默认打印所有

        // 检查是否匹配过滤器（使用正则匹配）
        if (DEBUG_CONFIG.receiveFilters.length > 0 && messageType) {
            shouldLog = isMessageTypeMatch(messageType, DEBUG_CONFIG.receiveFilters);
        }

        if (shouldLog) {
            if (messageData instanceof ArrayBuffer) {
                console.log('%c[MYTools WS接收]', 'color: #4CAF50; font-weight: bold;',
                    `(类型: ${messageType || '未知'})`, parsedData);
            } else {
                console.log('%c[MYTools WS接收]', 'color: #4CAF50; font-weight: bold;',
                    `(类型: ${messageType || '未知'})`, messageData);
            }
        }
    }

    // 处理发送消息
    function handleOutgoingMessage(data) {
        // 解析用户信息
        if (!userInfo) {
            userInfo = parseUserInfo(data);
        }

        // 触发自定义发送事件
        window.dispatchEvent(new CustomEvent('websocket-send', {
            detail: { data, userInfo }
        }));

        // 解析消息类型
        let messageType = null;
        let parsedData = null;
        try {
            if (typeof data === 'string' && data.length > 2) {
                if (data.startsWith('42')) {
                    const payload = JSON.parse(data.substring(2));
                    messageType = payload[0];
                    parsedData = payload[1];
                } else {
                    const payload = JSON.parse(data);
                    messageType = Array.isArray(payload) ? payload[0] : null;
                    parsedData = Array.isArray(payload) ? payload[1] : payload;
                }
            }
        } catch (e) {
            // 解析失败，忽略
        }

        // 调用注册的发送消息处理器
        if (messageType) {
            // 遍历所有注册的发送消息处理器
            for (const [type, handlers] of sendMessageHandlers) {
                let match = false;

                // 检查是否匹配
                if (typeof type === 'string') {
                    match = type === messageType;
                } else if (type instanceof RegExp) {
                    match = type.test(messageType);
                }

                // 如果匹配，调用所有相关的处理函数
                if (match) {
                    handlers.forEach(handler => {
                        try {
                            // 传递消息类型、解析后的参数和原始数据
                            handler(messageType, parsedData, data);
                        } catch (e) {
                            console.error('[MYTools] 发送消息处理器执行出错:', e);
                        }
                    });
                }
            }
        }
    }

    // 处理接收消息
    function handleIncomingMessage(messageData, ws) {
        // 处理压缩消息
        if (messageData instanceof ArrayBuffer) {
            try {
                const text = pako.inflate(new Uint8Array(messageData), { to: 'string' });
                let parsedData;
                let messageType = null;
                try {
                    parsedData = parseSocketIOMessage(text);
                    messageType = Array.isArray(parsedData) ? parsedData[0] : 'data';

                    // 特殊处理data类型消息，拼接上一条消息类型
                    if (messageType === 'data' && lastMessageType) {
                        messageType = `data:${lastMessageType}`;
                    } else if (messageType !== 'data') {
                        lastMessageType = messageType;
                    }
                } catch {
                    parsedData = text;
                }

                // 处理调试打印
                handleReceiveDebugLogging(messageData, parsedData, messageType);

                processParsedMessage(parsedData, messageData, messageType);
            } catch (err) {
                console.error('[MYTools] 消息解压失败:', err);
            }
        } else {
            // 处理文本消息
            try {
                const payload = parseSocketIOMessage(messageData);
                let messageType = Array.isArray(payload) ? payload[0] : null;

                // 特殊处理data类型消息，拼接上一条消息类型
                if (messageType === 'data' && lastMessageType) {
                    messageType = `data:${lastMessageType}`;
                } else if (messageType !== 'data') {
                    lastMessageType = messageType;
                }

                // 处理调试打印
                handleReceiveDebugLogging(messageData, payload, messageType);

                processParsedMessage(payload, messageData, messageType);
            } catch (err) {
                // 处理调试打印
                handleReceiveDebugLogging(messageData, messageData, null);

                console.error('[MYTools] 消息解析失败:', err);
            }
        }
    }

    // 处理解析后的消息
    function processParsedMessage(parsedData, originalData, messageTypeOverride) {
        // 触发消息接收事件
        window.dispatchEvent(new CustomEvent('websocket-receive', {
            detail: { data: parsedData, originalData }
        }));

        let messageType = messageTypeOverride || parsedData[0];
        if (!messageType) return;
        const messagePayload = messageType.startsWith('data') ? parsedData : parsedData[1];

        // 遍历所有注册的接收消息处理器
        for (const [type, handlers] of messageHandlers) {
            let match = false;

            // 检查是否匹配
            if (typeof type === 'string') {
                match = type === messageType;
            } else if (type instanceof RegExp) {
                match = type.test(messageType);
            }

            // 如果匹配，调用所有相关的处理函数
            if (match) {
                handlers.forEach(handler => {
                    try {
                        // 传递消息类型、解析后的参数和原始数据
                        handler(messageType, messagePayload, originalData);
                    } catch (e) {
                        console.error('[MYTools] 接收消息处理器执行出错:', e);
                    }
                });
            }
        }
    }

    // 解析用户信息
    function parseUserInfo(data) {
        try {
            if (typeof data === 'string' && data.length > 2) {
                const payload = JSON.parse(data.substring(2, data.length));
                if (payload[1] && payload[1]['user'] && payload[1]['user']['name']) {
                    return payload[1]['user'];
                }
            }
        } catch (e) {
            // 解析失败，忽略
        }
        return null;
    }

    // 注册消息处理器
    function registerMessageHandler(messageType, handler) {
        // 支持字符串类型和正则表达式
        if (typeof messageType !== 'string' && !(messageType instanceof RegExp)) {
            console.error('[MYTools] 消息类型必须是字符串或正则表达式');
            return;
        }

        // 确保有一个数组来存储处理函数
        if (!messageHandlers.has(messageType)) {
            messageHandlers.set(messageType, []);
        }

        // 添加处理函数到数组
        messageHandlers.get(messageType).push(handler);
    }

    // 注册发送消息处理器
    function registerSendMessageHandler(messageType, handler) {
        // 支持字符串类型和正则表达式
        if (typeof messageType !== 'string' && !(messageType instanceof RegExp)) {
            console.error('[MYTools] 消息类型必须是字符串或正则表达式');
            return;
        }

        // 确保有一个数组来存储处理函数
        if (!sendMessageHandlers.has(messageType)) {
            sendMessageHandlers.set(messageType, []);
        }

        // 添加处理函数到数组
        sendMessageHandlers.get(messageType).push(handler);
    }

    // 注册插件图标和点击事件
    function registerPluginIcon(icon, title = '', customOnClick = null) {
        const pluginId = registeredPlugins.length;
        // 使用标题生成稳定的标识符
        const stableId = generateStableId(title);
        registeredPlugins.push({ icon, title, customOnClick, stableId });

        // 确保插件Icon面板已创建
        if (!pluginIconPanel) {
            console.warn('[MYTools] Plugin panel not initialized');
            return pluginId;
        }

        // 创建插件图标元素
        const iconElement = createIconButton(icon, 'mytools-plugin-icon', (e) => {
            e.stopPropagation();
            // 如果有自定义点击事件，则执行自定义事件
            if (customOnClick && typeof customOnClick === 'function') {
                customOnClick();
            } else {
                // 否则执行默认的面板显示事件
                // 检查保存的面板类型并显示对应面板
                const pluginConfig = PLUGIN_PANEL_CONFIG[stableId];
                if (pluginConfig && pluginConfig.type === 'statusBar') {
                    // 显示状态栏
                    showStatusBar({ stableId, icon, title });
                } else {
                    // 显示插件面板
                    showPluginPanel(pluginId);
                }
            }
        });
        iconElement.title = title;
        iconElement.dataset.pluginId = pluginId;
        iconElement.dataset.stableId = stableId;

        // 添加到插件图标面板
        pluginIconPanel.appendChild(iconElement);

        return pluginId;
    }

    // 生成稳定的标识符
    function generateStableId(title) {
        // 使用更稳定的base64编码方式生成标识符
        try {
            // Base64编码并清理特殊字符
            let encoded = btoa(unescape(encodeURIComponent(title)))
                .replace(/[^a-zA-Z0-9]/g, '')
                .toLowerCase();

            // 确保以字母开头（HTML ID 规范）
            if (!/^[a-z]/.test(encoded)) {
                encoded = 'a' + encoded;
            }

            return encoded;
        } catch (e) {
            // 如果base64编码失败，使用备用方法
            let cleanTitle = title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').toLowerCase();

            // 确保以字母开头
            if (!/^[a-z]/.test(cleanTitle)) {
                cleanTitle = 'a' + cleanTitle;
            }

            return cleanTitle || 'defaultpluginid';
        }
    }

    // 注册插件面板
    function registerPluginPanel(pluginId, content, createdCallback = null) {
        const plugin = registeredPlugins[pluginId];
        if (!plugin) {
            console.warn(`[MYTools] 未找到插件ID ${pluginId}`);
            return;
        }

        const position = PLUGIN_PANEL_CONFIG[plugin.stableId]?.position || { x: 100, y: 100 };

        registeredPanels.set(plugin.stableId, {
            title: plugin.title,
            content,
            position,
            createdCallback
        });

        // 如果该面板之前是打开的，则自动显示
        if (PLUGIN_PANEL_CONFIG[plugin.stableId] && PLUGIN_PANEL_CONFIG[plugin.stableId].isOpen
            && PLUGIN_PANEL_CONFIG[plugin.stableId].type === 'panel') {
            setTimeout(() => {
                showPluginPanel(pluginId);
            }, 1000);
        }
    }

    // 注册插件状态栏内容
    function registerPluginStatusBar(pluginId, content, createdCallback = null) {
        const plugin = registeredPlugins[pluginId];
        if (!plugin) {
            console.warn(`[MYTools] 未找到插件ID ${pluginId}`);
            return;
        }

        registeredStatusBarItems.set(plugin.stableId, {
            content,
            createdCallback
        });

        // 如果该面板之前是打开的，则自动显示
        if (PLUGIN_PANEL_CONFIG[plugin.stableId] && PLUGIN_PANEL_CONFIG[plugin.stableId].isOpen
            && PLUGIN_PANEL_CONFIG[plugin.stableId].type === 'statusBar') {
            setTimeout(() => {
                showStatusBar(plugin);
            }, 1000);
        }
    }

    // 显示插件面板
    function showPluginPanel(pluginId) {
        const plugin = registeredPlugins[pluginId];
        if (!plugin) {
            console.warn(`[MYTools] 未找到插件ID ${pluginId}`);
            return;
        }

        const panelData = registeredPanels.get(plugin.stableId);

        // 检查面板是否已存在
        let panel = document.getElementById(`mytools-plugin-panel-${plugin.stableId}`);

        if (!panel) {
            // 创建面板
            panel = document.createElement('div');
            panel.id = `mytools-plugin-panel-${plugin.stableId}`;
            panel.className = 'mytools-plugin-custom-panel';
            panel.dataset.stableId = plugin.stableId;

            // 先设置基本样式以计算尺寸
            panel.style.cssText = `
                position: fixed;
                width: 320px;
                background: rgba(25, 35, 45, 0.95);
                color: #fff;
                border: 1px solid #3498db;
                border-radius: 10px;
                padding: 8px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                backdrop-filter: blur(10px);
                z-index: 10000;
                font-family: 'Consolas', monospace;
                font-size: 12px;
                display: block;
                visibility: hidden;
                top: 0;
                left: 0;
            `;

            // 面板标题使用插件注册时的标题
            const title = plugin.title;

            // 创建面板头部
            const panelHeader = document.createElement('div');
            panelHeader.className = 'mytools-plugin-panel-header';
            panelHeader.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #3498db; cursor: move;';

            // 创建标题容器
            const panelTitle = document.createElement('div');
            panelTitle.className = 'mytools-plugin-panel-title';
            panelTitle.style.cssText = 'font-size: 16px; font-weight: bold; color: #3498db; display: flex; align-items: center;';

            // 创建图标按钮
            const iconButton = createIconButton(plugin.icon, 'mytools-plugin-panel-icon', (e) => {
                // 隐藏插件面板
                panel.style.display = 'none';
                // 显示状态栏
                showStatusBar(plugin);
            });

            // 将图标和标题添加到标题容器
            panelTitle.appendChild(iconButton);

            const titleText = document.createElement('span');
            titleText.textContent = title;
            panelTitle.appendChild(titleText);

            // 创建控制按钮容器
            const panelControls = document.createElement('div');
            panelControls.className = 'mytools-plugin-panel-controls';
            panelControls.style.cssText = 'display: flex; gap: 4px;';

            // 创建固定按钮
            const pinButton = document.createElement('button');
            pinButton.className = 'mytools-plugin-panel-pin';
            pinButton.title = 'pin';
            pinButton.style.cssText = 'background: none; border: none; color: white; font-size: 16px; cursor: pointer; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 50%';
            pinButton.textContent = '📌';

            // 创建关闭按钮
            const closeButton = document.createElement('button');
            closeButton.className = 'mytools-plugin-panel-close';
            closeButton.style.cssText = 'background: none; border: none; color: red; font-size: 16px; cursor: pointer; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 50%';
            closeButton.textContent = '❌';

            // 将按钮添加到控制容器
            panelControls.appendChild(pinButton);
            panelControls.appendChild(closeButton);

            // 将标题和控制按钮添加到面板头部
            panelHeader.appendChild(panelTitle);
            panelHeader.appendChild(panelControls);

            // 创建面板内容区域
            const panelContent = document.createElement('div');
            panelContent.className = 'mytools-plugin-panel-content';

            if (panelData && panelData.content) {
                panelContent.innerHTML = panelData.content;
            }

            const logsSection = createPluginLogsSection(pluginId);
            panelContent.appendChild(logsSection);

            // 将头部和内容添加到面板
            panel.appendChild(panelHeader);
            panel.appendChild(panelContent);

            document.body.appendChild(panel);

            // 计算面板实际尺寸
            const panelWidth = panel.offsetWidth || 320;
            const panelHeight = panel.offsetHeight || 400;

            // 获取面板位置
            let position;
            if (PLUGIN_PANEL_CONFIG[plugin.stableId] && PLUGIN_PANEL_CONFIG[plugin.stableId].position) {
                position = PLUGIN_PANEL_CONFIG[plugin.stableId].position;
            } else if (panelData && panelData.position) {
                position = panelData.position;
            } else {
                // 默认位置与主配置面板一致
                position = calculateDefaultPanelPosition(panelWidth, panelHeight);
            }

            // 设置最终位置和可见性
            panel.style.left = `${position.x}px`;
            panel.style.top = `${position.y}px`;
            panel.style.visibility = 'visible';

            // 添加固定按钮事件
            pinButton.addEventListener('click', () => {
                // 隐藏当前面板
                panel.style.display = 'none';
                // 创建状态栏图标，传递面板位置信息
                showStatusBar(plugin);
            });

            // 添加关闭按钮事件
            closeButton.addEventListener('click', () => {
                // 保存面板位置
                const rect = panel.getBoundingClientRect();
                panel.style.display = 'none';
                savePluginPanelConfig(plugin.stableId, { isOpen: false });
            });

            // 添加拖动功能
            const cleanupDrag = setupDraggable(panelHeader,
                null,
                null,
                (x, y) => {
                    panel.style.left = `${x}px`;
                    panel.style.top = `${y}px`;
                    savePluginPanelConfig(plugin.stableId, { position: { x, y } });
                }
            );

            // 在面板移除时清理拖动事件
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    mutation.removedNodes.forEach((node) => {
                        if (node === panel) {
                            cleanupDrag();
                            observer.disconnect();
                        }
                    });
                });
            });

            observer.observe(document.body, { childList: true, subtree: true });

            // 如果有创建回调函数，则执行
            if (panelData && typeof panelData.createdCallback === 'function') {
                panelData.createdCallback(panel);
            }

            savePluginPanelConfig(plugin.stableId, { position: position, type: 'panel', isOpen: true }); // 面板打开
        } else {
            // 面板已存在，切换显示/隐藏状态
            if (panel.style.display === 'none') {
                panel.style.display = 'block';

                // 检查是否存在对应的状态栏面板，如果存在则隐藏
                const statusBarPanel = document.getElementById(`mytools-status-bar-panel-${plugin.stableId}`);
                if (statusBarPanel) {
                    statusBarPanel.style.display = 'none';
                }

                // 保存面板打开状态
                savePluginPanelConfig(plugin.stableId, { type: 'panel', isOpen: true }); // 面板打开
            } else {
                // 保存面板位置
                const rect = panel.getBoundingClientRect();
                // 隐藏当前面板
                panel.style.display = 'none';
                savePluginPanelConfig(plugin.stableId, { isOpen: false }); // 面板关闭
            }
        }
    }

    // 创建状态栏面板
    function showStatusBar(plugin, x, y) {
        // 检查是否已存在状态栏面板
        let statusBarPanel = document.getElementById(`mytools-status-bar-panel-${plugin.stableId}`);
        if (!statusBarPanel) {
            // 如果没有提供位置信息，则尝试从保存的位置加载
            if (x === undefined || y === undefined) {
                const savedPosition = PLUGIN_PANEL_CONFIG[plugin.stableId]?.position;
                // 使用统一的位置信息
                if (savedPosition && savedPosition.x !== undefined && savedPosition.y !== undefined) {
                    x = savedPosition.x;
                    y = savedPosition.y;
                } else if (savedPosition) {
                    // 如果没有专门的位置，则使用默认值
                    x = savedPosition.x || 20;
                    y = savedPosition.y || 20;
                } else {
                    // 默认位置
                    x = 20;
                    y = 20;
                }
            }

            // 创建状态栏面板容器
            statusBarPanel = document.createElement('div');
            statusBarPanel.id = `mytools-status-bar-panel-${plugin.stableId}`;
            statusBarPanel.className = 'mytools-status-bar-panel';
            statusBarPanel.dataset.stableId = plugin.stableId;
            statusBarPanel.title = plugin.title;

            // 设置样式
            statusBarPanel.style.cssText = `
                position: fixed;
                left: ${x}px;
                top: ${y}px;
                height: 40px;
                background: rgba(25, 35, 45, 0.95);
                color: white;
                border: 1px solid #3498db;
                border-radius: 8px;
                display: flex;
                align-items: center;
                cursor: move;
                z-index: 9999;
                box-shadow: 0 5px 15px rgba(0,0,0,0.3);
                backdrop-filter: blur(10px);
                padding: 0 5px;
            `;

            const iconButton = createIconButton(plugin.icon, 'mytools-status-bar-icon', (e) => {
                // 防止在拖动时触发点击事件
                if (isDragging || hasMoved) return;

                // 获取状态栏面板位置
                const rect = statusBarPanel.getBoundingClientRect();

                // 隐藏状态栏面板
                statusBarPanel.style.display = 'none';

                // 显示原始面板
                const panel = document.getElementById(`mytools-plugin-panel-${plugin.stableId}`);
                if (panel) {
                    // 设置面板位置为状态栏面板的位置，使面板左上角与状态栏面板左上角对齐
                    panel.style.left = `${rect.left}px`;
                    panel.style.top = `${rect.top}px`;
                    panel.style.display = 'block';

                    savePluginPanelConfig(plugin.stableId, { type: 'panel' });
                } else {
                    // 如果面板不存在，创建并显示面板
                    showPluginPanel(registeredPlugins.findIndex(p => p.stableId === plugin.stableId));
                }
            });

            // 创建内容容器
            const contentContainer = document.createElement('div');
            contentContainer.className = 'mytools-status-bar-content';
            contentContainer.style.cssText = `
                display: flex;
                align-items: center;
                height: 100%;
                padding: 0 5px;
                overflow: hidden;
                flex-shrink: 1;
            `;

            // 添加注册的内容
            const statusBarData = registeredStatusBarItems.get(plugin.stableId);
            if (statusBarData) {
                contentContainer.innerHTML = statusBarData.content;
            }

            // 组装状态栏面板
            statusBarPanel.appendChild(iconButton);
            statusBarPanel.appendChild(contentContainer);

            // 添加拖动功能
            setupDraggable(statusBarPanel, null, null, (newX, newY) => {
                statusBarPanel.style.left = `${newX}px`;
                statusBarPanel.style.top = `${newY}px`;

                // 保存状态栏面板位置
                savePluginPanelConfig(plugin.stableId, { position: { x: newX, y: newY } });
            });

            // 添加到页面
            document.body.appendChild(statusBarPanel);

            // 调用创建回调
            if (typeof statusBarData?.createdCallback === 'function') {
                statusBarData.createdCallback(statusBarPanel);
            }
            savePluginPanelConfig(plugin.stableId, { position: { x, y }, type: 'statusBar', isOpen: true });
        } else {
            // 状态栏面板已存在，切换显示/隐藏状态
            const rect = statusBarPanel.getBoundingClientRect();
            if (statusBarPanel.style.display === 'none') {
                statusBarPanel.style.display = 'flex';

                // 隐藏主面板（如果存在且显示）
                const mainPanel = document.getElementById(`mytools-plugin-panel-${plugin.stableId}`);
                if (mainPanel && mainPanel.style.display !== 'none') {
                    mainPanel.style.display = 'none';
                }
                savePluginPanelConfig(plugin.stableId, { type: 'statusBar', isOpen: true });
            } else {
                statusBarPanel.style.display = 'none';
            }
        }
    }

    function createIconButton(icon, className, clickEventHandler) {
        // 创建图标按钮
        const iconButton = document.createElement('div');
        iconButton.className = className;
        iconButton.style.cssText = `
                width: 36px;
                height: 36px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                border-radius: 50%;
                font-size: 20px;
                transition: all 0.2s;
                flex-shrink: 0;
            `;

        // 设置图标内容
        if (typeof icon === 'string') {
            if (icon.startsWith('<')) {
                // HTML格式
                iconButton.innerHTML = icon;
            } else {
                // 文本或emoji
                iconButton.textContent = icon;
            }
        } else if (icon instanceof HTMLElement) {
            // HTMLElement格式
            iconButton.appendChild(icon);
        } else {
            // 默认情况
            iconButton.textContent = '🔧';
        }

        // 添加与面板图标相同的悬停效果
        iconButton.addEventListener('mouseenter', () => {
            iconButton.style.transform = 'scale(1.1)';
            iconButton.style.boxShadow = '0 8px 20px rgba(0,0,0,0.4)';
        });

        iconButton.addEventListener('mouseleave', () => {
            iconButton.style.transform = 'scale(1)';
            iconButton.style.boxShadow = 'none';
        });

        if (clickEventHandler) {
            // 添加点击事件处理程序
            iconButton.addEventListener('click', (e) => clickEventHandler(e));
        }

        return iconButton;
    }

    function createToggleSection(name, defaultCollapsed = true) {
        const toggleSection = document.createElement('div');
        toggleSection.className = 'mytools-section';
        toggleSection.style.marginTop = '10px';

        const toggleSectionHeader = document.createElement('div');
        toggleSectionHeader.className = 'mytools-section-header';
        toggleSectionHeader.style.cursor = 'pointer';

        const toggle = document.createElement('span');
        toggle.className = 'mytools-section-toggle';
        toggle.textContent = name;
        toggle.style.display = 'flex';
        toggle.style.justifyContent = 'space-between';
        toggle.style.alignItems = 'center';
        const toggleIcon = document.createElement('span');
        toggleIcon.textContent = '▶';
        toggleIcon.style.fontSize = '12px';
        toggleIcon.style.marginLeft = '2px';
        toggleIcon.style.transition = 'transform 0.2s';
        toggle.appendChild(toggleIcon);

        toggleSectionHeader.appendChild(toggle);

        const toggleSectionContent = document.createElement('div');
        toggleSectionContent.className = 'mytools-section-content';
        toggleSectionContent.style.display = 'none';

        toggleSectionHeader.addEventListener('click', () => {
            const isCollapsed = toggleSectionContent.style.display === 'none';
            toggleSectionContent.style.display = isCollapsed ? 'block' : 'none';

            if (isCollapsed) {
                toggleIcon.style.transform = 'rotate(90deg)';
            } else {
                toggleIcon.style.transform = 'rotate(0deg)';
            }

        });
        toggleSection.appendChild(toggleSectionHeader);
        toggleSection.appendChild(toggleSectionContent);

        if (!defaultCollapsed) {
            toggleIcon.style.transform = 'rotate(90deg)';
            toggleSectionContent.style.display = 'block';
        }

        return {
            section: toggleSection,
            header: toggleSectionHeader,
            content: toggleSectionContent
        };
    }

    // 创建插件日志区域
    function createPluginLogsSection(pluginId) {
        const plugin = registeredPlugins[pluginId];
        if (!plugin) {
            console.warn(`[MYTools] 未找到插件ID ${pluginId}`);
            return;
        }

        const { section: logsSection, header: logsHeader, content: logsContent } = createToggleSection('执行日志');
        logsSection.id = `mytools-plugin-logs-section-${plugin.stableId}`;

        // 在标题中添加垃圾桶图标
        const clearButton = document.createElement('button');
        clearButton.className = 'mytools-plugin-clear-logs';
        clearButton.innerHTML = '🗑️';
        clearButton.style.cssText = 'background: #e74c3c; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; font-size: 12px; margin-left: 5px;';

        // 将垃圾桶图标添加到标题区域
        logsHeader.style.display = 'flex';
        logsHeader.style.alignItems = 'center';
        logsHeader.style.justifyContent = 'space-between';
        logsHeader.appendChild(clearButton);

        // 在内容区域添加日志容器
        const logsContainer = document.createElement('div');
        logsContainer.className = 'mytools-plugin-logs-container';
        logsContainer.style.cssText = 'background: rgba(0,0,0,0.3); border: 1px solid #3498db; border-radius: 4px; padding: 10px; font-family: monospace; font-size: 11px; resize: both; overflow: auto; min-height: 50px; max-height: 300px;';
        logsContent.appendChild(logsContainer);

        clearButton?.addEventListener('click', (e) => {
            e.stopPropagation(); // 防止触发折叠/展开
            clearPluginLogs(pluginId);
        });

        return logsSection;
    }

    // 发送自定义消息
    function sendCustomMessage(message) {
        if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
            console.error('[MYTools] WebSocket未连接或已关闭');
            return false;
        }

        try {
            currentSocket.send(message);
            return true;
        } catch (error) {
            console.error('[MYTools] 消息发送失败:', error);
            return false;
        }
    }

    // 发送自定义action消息
    function sendActionMessage(action, data) {
        let message = `42["${action}",{"user":${JSON.stringify(userInfo)},"data":${JSON.stringify(data)}}]`
        return sendCustomMessage(message);
    }

    // 保存配置
    function saveConfig() {
        GM_setValue('mytools_debug_enabled', DEBUG_CONFIG.enabled);
        GM_setValue('mytools_debug_sendFilters', DEBUG_CONFIG.sendFilters);
        GM_setValue('mytools_debug_receiveFilters', DEBUG_CONFIG.receiveFilters);
        GM_setValue('mytools_button_x', UI_CONFIG.buttonPosition.x);
        GM_setValue('mytools_button_y', UI_CONFIG.buttonPosition.y);
        GM_setValue('mytools_panel_x', UI_CONFIG.panelPosition.x);
        GM_setValue('mytools_panel_y', UI_CONFIG.panelPosition.y);
        GM_setValue('mytools_panel_minimized', UI_CONFIG.panelMinimized);
    }

    // 保存插件面板位置和类型
    function savePluginPanelConfig(stableId, config) {
        PLUGIN_PANEL_CONFIG[stableId] = {
            ...(PLUGIN_PANEL_CONFIG[stableId] || {}),
            ...config
        };
        GM_setValue('mytools_plugin_panel_config', PLUGIN_PANEL_CONFIG);
    }

    // 自动保存配置（无需手动点击保存）
    function autoSaveConfig() {
        // 从UI获取当前值并保存
        const enabledCheckbox = document.getElementById('mytools-ws-debug-enabled');
        DEBUG_CONFIG.enabled = enabledCheckbox.checked;

        const sendFiltersText = document.getElementById('mytools-send-filters').value;
        DEBUG_CONFIG.sendFilters = sendFiltersText ? sendFiltersText.split('\n').filter(f => f.trim()) : [];

        const receiveFiltersText = document.getElementById('mytools-receive-filters').value;
        DEBUG_CONFIG.receiveFilters = receiveFiltersText ? receiveFiltersText.split('\n').filter(f => f.trim()) : [];

        saveConfig();
    }

    // 创建悬浮按钮和配置面板
    function createUI() {
        // 添加样式
        const style = document.createElement('style');
        style.textContent = `
            #mytools-plugin-panel {
                position: fixed;
                top: ${UI_CONFIG.buttonPosition.y + 50}px;
                left: ${UI_CONFIG.buttonPosition.x}px;
                width: 40px;
                background: transparent;
                border: none;
                border-radius: 0;
                z-index: 10001;
                display: none;
                flex-direction: column;
                align-items: center;
                padding: 5px 0;
                box-shadow: 0 5px 15px rgba(0,0,0,0.3);
            }

            .mytools-plugin-icon {
                width: 40px;
                height: 40px;
                margin: 2px 0;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                border-radius: 50%;
                transition: all 0.2s;
                font-size: 28px;
                box-shadow: 0 5px 15px rgba(0,0,0,0.3);
                background: transparent;
                color: white;
                border: none;
                font-weight: bold;
                user-select: none;
                will-change: transform;
            }

            .mytools-plugin-icon:hover {
                background: rgba(40, 50, 90, 0.3);
                transform: scale(1.05);
            }

            #mytools-config-panel {
                position: fixed;
                top: ${UI_CONFIG.panelPosition.y}px;
                left: ${UI_CONFIG.panelPosition.x}px;
                width: 320px;
                background: rgba(25, 35, 45, 0.95);
                color: #fff;
                border: 1px solid #3498db;
                border-radius: 10px;
                padding: 8px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                backdrop-filter: blur(10px);
                z-index: 10000;
                font-family: 'Consolas', monospace;
                font-size: 12px;
                display: ${UI_CONFIG.panelMinimized ? 'none' : 'block'};
                will-change: transform;
            }

            #mytools-floating-button {
                position: fixed;
                top: ${UI_CONFIG.buttonPosition.y}px;
                left: ${UI_CONFIG.buttonPosition.x}px;
                width: 40px;
                height: 40px;
                background: transparent;
                color: white;
                border: none;
                border-radius: 50%;
                font-size: 28px;
                font-weight: bold;
                cursor: move;
                box-shadow: 0 5px 15px rgba(0,0,0,0.3);
                transition: all 0.2s;
                z-index: 10001;
                display: flex;
                align-items: center;
                justify-content: center;
                user-select: none;
                will-change: transform;
            }

            #mytools-floating-button:hover {
                background: rgba(40, 50, 90, 0.3);
                transform: scale(1.05);
            }

            #mytools-config-panel .header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 6px;
                padding-bottom: 2px;
                border-bottom: 1px solid #3498db;
                cursor: move;
            }

            #mytools-config-panel .title {
                font-size: 16px;
                font-weight: bold;
                color: #3498db;
            }

            #mytools-config-panel .toolbar {
                display: flex;
                gap: 8px;
            }

            #mytools-config-panel .toolbar-btn {
                background: none;
                border: none;
                color: white;
                font-size: 16px;
                cursor: pointer;
                width: 24px;
                height: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 50%;
                transition: background 0.2s;
            }

            #mytools-config-panel .toolbar-btn:hover {
                background: rgba(255,255,255,0.1);
            }

            #mytools-config-panel .minimize-btn::before {
                content: '−';
            }

            #mytools-config-panel .close-btn {
                position: relative;
            }

            #mytools-config-panel .control-group {
                margin-bottom: 3px;
            }

            #mytools-config-panel .control-label {
                display: block;
                margin-bottom: 2px;
                color: #aaa;
                font-size: 11px;
            }

            #mytools-config-panel .checkbox-label {
                display: flex;
                align-items: center;
                font-size: 12px;
                margin-bottom: 8px;
                cursor: pointer;
            }

            #mytools-config-panel .checkbox-label input {
                margin-right: 8px;
            }

            #mytools-config-panel .textarea {
                width: 100%;
                background: rgba(0,0,0,0.3);
                border: 1px solid #3498db;
                border-radius: 4px;
                color: white;
                padding: 6px;
                font-family: 'Consolas', monospace;
                font-size: 11px;
                resize: vertical;
                min-height: 40px;
                height: 40px;
            }

            .mytools-section {
                border: 1px solid #3498db;
                border-radius: 4px;
                margin-bottom: 2px;
            }

            .mytools-section-header {
                background: rgba(0,0,0,0.2);
                padding: 6px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            .mytools-section-content {
                padding: 6px;
                padding-bottom: 3px;
            }
            
            .mytools-dragging {
                transition: none !important;
                box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            }
            
            .mytools-status-bar-icon {
                transition: all 0.2s;
            }
            
            .mytools-status-bar-icon:hover {
                transform: scale(1.1);
                box-shadow: 0 8px 20px rgba(0,0,0,0.4);
            }
            
            #mytools-plugin-icon-panel {
                position: fixed;
                top: ${UI_CONFIG.buttonPosition.y + 50}px;
                left: ${UI_CONFIG.buttonPosition.x}px;
                width: 40px;
                background: transparent;
                border: none;
                border-radius: 0;
                z-index: 10001;
                display: none;
                flex-direction: column;
                align-items: center;
                padding: 5px 0;
                box-shadow: none;
            }
        `;
        document.head.appendChild(style);

        const icon = '🐱';

        // 创建悬浮按钮
        floatingButton = document.createElement('div');
        floatingButton.id = 'mytools-floating-button';
        floatingButton.textContent = icon;
        floatingButton.title = 'MYTools 配置';
        document.body.appendChild(floatingButton);

        // 创建插件图标面板
        pluginIconPanel = document.createElement('div');
        pluginIconPanel.id = 'mytools-plugin-icon-panel';
        document.body.appendChild(pluginIconPanel);

        // 计算设置面板的初始位置
        const initialPanelLeft = UI_CONFIG.buttonPosition.x + 50;
        const initialPanelTop = UI_CONFIG.buttonPosition.y;

        // 更新面板位置配置
        UI_CONFIG.panelPosition.x = initialPanelLeft;
        UI_CONFIG.panelPosition.y = initialPanelTop;

        // 创建配置面板
        configPanel = document.createElement('div');
        configPanel.id = 'mytools-config-panel';

        // 创建面板头部
        const configPanelHeader = document.createElement('div');
        configPanelHeader.className = 'header';

        const configPanelIcon = createIconButton(icon, 'mytools-config-panel-icon', null);

        // 创建标题容器，将图标和标题放在一起
        const configPanelTitleContainer = document.createElement('div');
        configPanelTitleContainer.style.cssText = 'display: flex; align-items: center; gap: 8px;';

        // 创建标题
        const configPanelTitle = document.createElement('div');
        configPanelTitle.className = 'title';
        configPanelTitle.textContent = 'MYTools';

        // 将图标和标题添加到标题容器
        configPanelTitleContainer.appendChild(configPanelIcon);
        configPanelTitleContainer.appendChild(configPanelTitle);

        // 创建工具栏
        const configPanelToolbar = document.createElement('div');
        configPanelToolbar.className = 'toolbar';

        // 创建关闭按钮 (红x)
        const closeButton = document.createElement('button');
        closeButton.className = 'toolbar-btn close-btn';
        closeButton.innerHTML = '❌';
        closeButton.style.cssText = 'background: none; border: none; color: red; font-size: 16px; cursor: pointer; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 50%;';

        // 组装头部
        configPanelToolbar.appendChild(closeButton);
        configPanelHeader.appendChild(configPanelTitleContainer);
        configPanelHeader.appendChild(configPanelToolbar);

        // 消息调试区域（默认折叠）
        const { section: wsDebugSection, header: wsDebugHeader, content: wsDebugContent } = createToggleSection('消息调试');
        // 消息调试区域-内容-开关
        const wsDebugCheckboxLabel = document.createElement('label');
        wsDebugCheckboxLabel.className = 'checkbox-label';
        const wsDebugCheckbox = document.createElement('input');
        wsDebugCheckbox.type = 'checkbox';
        wsDebugCheckbox.id = 'mytools-ws-debug-enabled';
        if (DEBUG_CONFIG.enabled) {
            wsDebugCheckbox.checked = true;
        }
        const wsDebugCheckboxText = document.createElement('span');
        wsDebugCheckboxText.textContent = '调试ws消息';
        wsDebugCheckboxLabel.appendChild(wsDebugCheckbox);
        wsDebugCheckboxLabel.appendChild(wsDebugCheckboxText);

        // 消息调试区域-内容-消息过滤设置区域
        const { section: wsDebugFilterSection, header: wsDebugFilterHeader, content: wsDebugFilterContent } = createToggleSection('消息过滤器设置');
        // 消息调试区域-内容-消息过滤设置区域-内容-发送消息过滤器
        const wsDebugSendFilterGroup = document.createElement('div');
        wsDebugSendFilterGroup.className = 'control-group';
        const wsDebugSendFilterLabel = document.createElement('label');
        wsDebugSendFilterLabel.className = 'control-label';
        wsDebugSendFilterLabel.textContent = '发送消息过滤器 (支持正则表达式，每行一个)';
        const wsDebugSendFilterTextarea = document.createElement('textarea');
        wsDebugSendFilterTextarea.className = 'textarea';
        wsDebugSendFilterTextarea.id = 'mytools-send-filters';
        wsDebugSendFilterTextarea.placeholder = '支持正则表达式，例如: ^battle:.*';
        wsDebugSendFilterTextarea.textContent = DEBUG_CONFIG.sendFilters.join('\n');
        wsDebugSendFilterGroup.appendChild(wsDebugSendFilterLabel);
        wsDebugSendFilterGroup.appendChild(wsDebugSendFilterTextarea);

        // 消息调试区域-内容-消息过滤设置区域-内容-接收消息过滤器
        const wsDebugReceiveFilterGroup = document.createElement('div');
        wsDebugReceiveFilterGroup.className = 'control-group';
        const wsDebugReceiveFilterLabel = document.createElement('label');
        wsDebugReceiveFilterLabel.className = 'control-label';
        wsDebugReceiveFilterLabel.textContent = '接收消息过滤器 (支持正则表达式，每行一个)';
        const wsDebugReceiveFilterTextarea = document.createElement('textarea');
        wsDebugReceiveFilterTextarea.className = 'textarea';
        wsDebugReceiveFilterTextarea.id = 'mytools-receive-filters';
        wsDebugReceiveFilterTextarea.placeholder = '支持正则表达式，例如: ^(?!battle:|data:battle:).*$';
        wsDebugReceiveFilterTextarea.textContent = DEBUG_CONFIG.receiveFilters.join('\n');
        wsDebugReceiveFilterGroup.appendChild(wsDebugReceiveFilterLabel);
        wsDebugReceiveFilterGroup.appendChild(wsDebugReceiveFilterTextarea);

        wsDebugFilterContent.appendChild(wsDebugSendFilterGroup);
        wsDebugFilterContent.appendChild(wsDebugReceiveFilterGroup);

        wsDebugFilterSection.appendChild(wsDebugFilterHeader);
        wsDebugFilterSection.appendChild(wsDebugFilterContent);

        // 消息调试区域-内容-发送自定义消息
        const { section: wsDebugSendSection, header: wsDebugSendHeader, content: wsDebugSendContent } = createToggleSection('发送自定义消息');
        // 消息调试区域-内容-发送自定义消息-内容-消息类型
        const wsDebugSendTypeGroup = document.createElement('div');
        wsDebugSendTypeGroup.className = 'control-group';
        wsDebugSendTypeGroup.style.display = 'flex';
        wsDebugSendTypeGroup.style.alignItems = 'center';
        const wsDebugSendTypeLabel = document.createElement('label');
        wsDebugSendTypeLabel.className = 'control-label';
        wsDebugSendTypeLabel.textContent = '类型';
        wsDebugSendTypeLabel.style.marginBottom = '0';
        wsDebugSendTypeLabel.style.marginRight = '8px';
        wsDebugSendTypeLabel.style.flexShrink = '0';
        const wsDebugSendTypeInput = document.createElement('input');
        wsDebugSendTypeInput.type = 'text';
        wsDebugSendTypeInput.className = 'textarea';
        wsDebugSendTypeInput.id = 'mytools-send-action-type';
        wsDebugSendTypeInput.style.flex = '1';
        wsDebugSendTypeInput.style.minHeight = '20px';
        wsDebugSendTypeInput.style.height = '20px'
        wsDebugSendTypeGroup.appendChild(wsDebugSendTypeLabel);
        wsDebugSendTypeGroup.appendChild(wsDebugSendTypeInput);
        // 消息调试区域-内容-发送自定义消息-内容-消息数据
        const wsDebugSendDataGroup = document.createElement('div');
        wsDebugSendDataGroup.className = 'control-group';
        const wsDebugSendDataLabel = document.createElement('label');
        wsDebugSendDataLabel.className = 'control-label';
        wsDebugSendDataLabel.textContent = '数据';
        const wsDebugSendDataInput = document.createElement('textarea');
        wsDebugSendDataInput.className = 'textarea';
        wsDebugSendDataInput.id = 'mytools-send-action-data';
        wsDebugSendDataGroup.appendChild(wsDebugSendDataLabel);
        wsDebugSendDataGroup.appendChild(wsDebugSendDataInput);
        // 消息调试区域-内容-发送自定义消息-内容-发送按钮
        const wsDebugSendButtonGroup = document.createElement('div');
        wsDebugSendButtonGroup.className = 'control-group';
        const wsDebugSendButton = document.createElement('button');
        wsDebugSendButton.className = 'toolbar-btn';
        wsDebugSendButton.textContent = '发送消息';
        wsDebugSendButton.style.background = '#3498db';
        wsDebugSendButton.style.color = 'white';
        wsDebugSendButton.style.border = 'none';
        wsDebugSendButton.style.padding = '6px 12px';
        wsDebugSendButton.style.borderRadius = '4px';
        wsDebugSendButton.style.cursor = 'pointer';
        wsDebugSendButton.style.width = '100%';
        wsDebugSendButton.style.fontSize = '14px';
        wsDebugSendButtonGroup.appendChild(wsDebugSendButton);

        wsDebugSendContent.appendChild(wsDebugSendTypeGroup);
        wsDebugSendContent.appendChild(wsDebugSendDataGroup);
        wsDebugSendContent.appendChild(wsDebugSendButtonGroup);

        wsDebugContent.appendChild(wsDebugCheckboxLabel);
        wsDebugContent.appendChild(wsDebugFilterSection);
        wsDebugContent.appendChild(wsDebugSendSection);

        configPanel.appendChild(configPanelHeader);
        configPanel.appendChild(wsDebugSection);

        document.body.appendChild(configPanel);

        // 添加关闭按钮事件监听器
        closeButton.addEventListener('click', () => {
            UI_CONFIG.panelMinimized = true;
            configPanel.style.display = 'none';
            saveConfig();
        });

        // 添加发送按钮事件监听器
        wsDebugSendButton.addEventListener('click', () => {
            const msgType = wsDebugSendTypeInput.value.trim();
            const dataText = wsDebugSendDataInput.value.trim() || '{}';

            if (!action) {
                console.error('请输入action');
                return;
            }

            try {
                const data = JSON.parse(dataText);
                unsafeWindow.MYTools.sendActionMessage(msgType, data);
                console.log(`[MYTools] 已发送消息: action=${action}, data=`, data);
            } catch (e) {
                console.error('数据格式错误: ' + e.message);
            }
        });

        // ws调试勾选框事件监听器
        wsDebugCheckbox.addEventListener('change', () => {
            DEBUG_CONFIG.enabled = wsDebugCheckbox.checked;
            saveConfig();
        });

        // 添加事件监听器
        initUIEventListeners();

        isUIReady = true;
    }

    // 调整面板位置，确保面板在屏幕内显示
    function adjustPanelPosition() {
        // 获取按钮位置
        const buttonRect = floatingButton.getBoundingClientRect();

        // 面板尺寸
        const panelWidth = 320;
        const panelHeight = configPanel.offsetHeight || 400;

        // 获取视窗尺寸
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let panelLeft, panelTop;

        // 默认放在按钮右侧
        panelLeft = UI_CONFIG.buttonPosition.x + 50;
        panelTop = UI_CONFIG.buttonPosition.y;

        // 检查右侧是否放得下
        if (panelLeft + panelWidth > viewportWidth) {
            // 右侧放不下，尝试放在左侧
            panelLeft = UI_CONFIG.buttonPosition.x - panelWidth - 10;

            // 检查左侧是否也放不下
            if (panelLeft < 0) {
                // 左侧也放不下，强制放在右侧并调整
                panelLeft = Math.max(0, viewportWidth - panelWidth - 10);
            }
        }

        // 检查下方是否放得下
        if (panelTop + panelHeight > viewportHeight) {
            // 下方放不下，调整位置
            panelTop = Math.max(0, viewportHeight - panelHeight - 10);
        }

        // 应用位置
        configPanel.style.left = `${panelLeft}px`;
        configPanel.style.top = `${panelTop}px`;

        // 更新配置
        UI_CONFIG.panelPosition.x = panelLeft;
        UI_CONFIG.panelPosition.y = panelTop;
    }

    // 初始化UI事件监听器
    function initUIEventListeners() {
        // 悬浮按钮鼠标进入事件
        floatingButton.addEventListener('mouseenter', () => {
            if (registeredPlugins.length > 0) {
                pluginIconPanel.style.display = 'flex';
            }
        });

        // 悬浮按钮鼠标离开事件
        floatingButton.addEventListener('mouseleave', (e) => {
            // 添加延迟以确保鼠标事件正确处理
            setTimeout(() => {
                if (!pluginIconPanel.matches(':hover')) {
                    pluginIconPanel.style.display = 'none';
                }
            }, 100);
        });

        // 插件图标面板鼠标离开事件
        pluginIconPanel.addEventListener('mouseleave', () => {
            pluginIconPanel.style.display = 'none';
        });

        // 替换原有的按钮点击事件监听器
        floatingButton.addEventListener('click', (e) => {
            // 只有非拖动操作时才响应点击
            if (!isDragging && !hasMoved) {
                UI_CONFIG.panelMinimized = !UI_CONFIG.panelMinimized;

                // 检查面板位置，决定放在左侧还是右侧
                if (!UI_CONFIG.panelMinimized) {
                    adjustPanelPosition();
                }

                configPanel.style.display = UI_CONFIG.panelMinimized ? 'none' : 'block';
                // 点击时隐藏插件图标面板
                pluginIconPanel.style.display = 'none';
                saveConfig();
            }
        });

        // 自动保存配置（输入时延迟保存）
        let saveTimeout = null;
        const autoSaveInputs = [
            'mytools-ws-debug-enabled',
            'mytools-send-filters',
            'mytools-receive-filters'
        ];

        autoSaveInputs.forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.addEventListener('input', () => {
                    clearTimeout(saveTimeout);
                    saveTimeout = setTimeout(() => {
                        autoSaveConfig();
                    }, 500); // 500ms延迟保存
                });

                // 对于复选框，立即保存
                if (element.type === 'checkbox') {
                    element.addEventListener('change', autoSaveConfig);
                }
            }
        });

        // 按钮拖动功能 (同时移动按钮和插件面板)
        setupDraggable(floatingButton,
            null, // drag start
            null, // drag move
            (x, y) => {
                UI_CONFIG.buttonPosition.x = x;
                UI_CONFIG.buttonPosition.y = y;
                saveConfig();
            }
        );

        // 面板标题栏拖动功能
        setupDraggable(configPanel.querySelector('.header'),
            null, // drag start
            null, // drag move
            (x, y) => {
                UI_CONFIG.panelPosition.x = x;
                UI_CONFIG.panelPosition.y = y;
                saveConfig();
            }
        );
    }

    // 封装拖动功能为独立函数
    function setupDraggable(element, onDragStart, onDragMove, onDragStop) {
        let startX, startY;
        let startLeft, startTop;
        let rafId = null;

        // 统一处理拖动开始
        function handleDragStart(clientX, clientY) {
            const rect = element.getBoundingClientRect();
            startX = clientX;
            startY = clientY;

            // 获取初始位置
            if (element === floatingButton) {
                startLeft = parseInt(floatingButton.style.left) || UI_CONFIG.buttonPosition.x;
                startTop = parseInt(floatingButton.style.top) || UI_CONFIG.buttonPosition.y;
            } else if (element === configPanel.querySelector('.header')) {
                startLeft = parseInt(configPanel.style.left) || UI_CONFIG.panelPosition.x;
                startTop = parseInt(configPanel.style.top) || UI_CONFIG.panelPosition.y;
            } else if (element.parentElement && element.parentElement.classList.contains('mytools-plugin-custom-panel')) {
                // 处理插件面板的拖动
                const panel = element.parentElement;
                startLeft = parseInt(panel.style.left) || 0;
                startTop = parseInt(panel.style.top) || 0;
            } else {
                startLeft = parseInt(element.style.left) || 0;
                startTop = parseInt(element.style.top) || 0;
            }

            isDragging = true;
            hasMoved = false;

            if (onDragStart) {
                onDragStart(startLeft, startTop);
            }

            element.classList.add('mytools-dragging');
            document.body.style.userSelect = 'none';

            // 在开始拖动时隐藏插件图标面板（仅对主按钮相关的情况）
            if (element === floatingButton && pluginIconPanel) {
                pluginIconPanel.style.display = 'none';
            }
        }

        // 统一处理拖动过程
        function handleDragMove(clientX, clientY) {
            if (!isDragging) return;

            const deltaX = clientX - startX;
            const deltaY = clientY - startY;
            const currentLeft = startLeft + deltaX;
            const currentTop = startTop + deltaY;

            // 判断是否有实际移动
            if (!hasMoved && (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2)) {
                hasMoved = true;
            }

            // 直接更新位置，避免使用requestAnimationFrame导致的延迟
            if (element === floatingButton) {
                floatingButton.style.left = `${currentLeft}px`;
                floatingButton.style.top = `${currentTop}px`;

                // 同步插件图标面板位置
                if (pluginIconPanel) {
                    pluginIconPanel.style.left = `${currentLeft}px`;
                    pluginIconPanel.style.top = `${currentTop + 50}px`;
                }
            } else if (element === configPanel.querySelector('.header')) {
                configPanel.style.left = `${currentLeft}px`;
                configPanel.style.top = `${currentTop}px`;
            } else if (element.parentElement && element.parentElement.classList.contains('mytools-plugin-custom-panel')) {
                // 处理插件面板的拖动
                const panel = element.parentElement;
                panel.style.left = `${currentLeft}px`;
                panel.style.top = `${currentTop}px`;
            } else {
                element.style.left = `${currentLeft}px`;
                element.style.top = `${currentTop}px`;
            }

            if (onDragMove) {
                onDragMove(currentLeft, currentTop);
            }
        }

        // 统一处理拖动结束
        function handleDragStop(clientX, clientY) {
            if (!isDragging) return;

            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('touchmove', touchMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);
            document.removeEventListener('touchend', touchEndHandler);

            element.classList.remove('mytools-dragging');
            document.body.style.userSelect = '';

            if (isDragging && hasMoved) {
                const deltaX = clientX - startX;
                const deltaY = clientY - startY;
                const finalLeft = startLeft + deltaX;
                const finalTop = startTop + deltaY;

                if (element === floatingButton) {
                    floatingButton.style.left = `${finalLeft}px`;
                    floatingButton.style.top = `${finalTop}px`;
                    // 同步插件图标面板位置
                    if (pluginIconPanel) {
                        pluginIconPanel.style.left = `${finalLeft}px`;
                        pluginIconPanel.style.top = `${finalTop + 50}px`;
                    }
                } else if (element === configPanel.querySelector('.header')) {
                    configPanel.style.left = `${finalLeft}px`;
                    configPanel.style.top = `${finalTop}px`;
                } else if (element.parentElement && element.parentElement.classList.contains('mytools-plugin-custom-panel')) {
                    // 处理插件面板的拖动结束，保存位置
                    const panel = element.parentElement;
                    panel.style.left = `${finalLeft}px`;
                    panel.style.top = `${finalTop}px`;

                    // 保存插件面板位置
                    const stableId = panel.dataset.stableId;
                    if (stableId) {
                        savePluginPanelConfig(stableId, { position: { x: finalLeft, y: finalTop } });
                    }
                } else {
                    element.style.left = `${finalLeft}px`;
                    element.style.top = `${finalTop}px`;
                }

                if (onDragStop) {
                    onDragStop(finalLeft, finalTop);
                }
            }

            isDragging = false;
            // 延迟重置 hasMoved，避免影响点击事件判断
            setTimeout(() => {
                hasMoved = false;
            }, 100);
        }

        // 鼠标事件处理函数
        function mouseMoveHandler(e) {
            handleDragMove(e.clientX, e.clientY);
        }

        function mouseUpHandler(e) {
            handleDragStop(e.clientX, e.clientY);
        }

        function mouseDownHandler(e) {
            // 只有在鼠标左键点击时才触发拖动
            if (e.button !== 0) return;

            e.preventDefault();
            element.style.cursor = 'grabbing';
            handleDragStart(e.clientX, e.clientY);
            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler);
        }

        // 触摸事件处理函数
        function touchMoveHandler(e) {
            if (e.touches.length > 0) {
                handleDragMove(e.touches[0].clientX, e.touches[0].clientY);
            }
            e.preventDefault();
        }

        function touchEndHandler(e) {
            if (e.changedTouches.length > 0) {
                handleDragStop(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
            }
            e.preventDefault();
        }

        function touchStartHandler(e) {
            if (e.touches.length > 0) {
                handleDragStart(e.touches[0].clientX, e.touches[0].clientY);
                document.addEventListener('touchmove', touchMoveHandler, { passive: false });
                document.addEventListener('touchend', touchEndHandler, { passive: false });
            }
            e.preventDefault();
        }

        // 绑定事件监听器
        element.addEventListener('mousedown', mouseDownHandler);
        element.addEventListener('touchstart', touchStartHandler, { passive: false });

        // 返回清理函数
        return function cleanup() {
            element.removeEventListener('mousedown', mouseDownHandler);
            element.removeEventListener('touchstart', touchStartHandler);
            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('touchmove', touchMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);
            document.removeEventListener('touchend', touchEndHandler);
        };
    }

    // 计算默认面板位置（与主配置面板一致）
    function calculateDefaultPanelPosition(panelWidth = 320, panelHeight = 400) {
        // 获取按钮位置
        const buttonRect = floatingButton.getBoundingClientRect();

        // 获取视窗尺寸
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let panelLeft, panelTop;

        // 默认放在按钮右侧
        panelLeft = UI_CONFIG.buttonPosition.x + 50;
        panelTop = UI_CONFIG.buttonPosition.y;

        // 检查右侧是否放得下
        if (panelLeft + panelWidth > viewportWidth) {
            // 右侧放不下，尝试放在左侧
            panelLeft = UI_CONFIG.buttonPosition.x - panelWidth - 10;

            // 检查左侧是否也放不下
            if (panelLeft < 0) {
                // 左侧也放不下，强制放在右侧并调整
                panelLeft = Math.max(0, viewportWidth - panelWidth - 10);
            }
        }

        // 检查下方是否放得下
        if (panelTop + panelHeight > viewportHeight) {
            // 下方放不下，调整位置
            panelTop = Math.max(0, viewportHeight - panelHeight - 10);
        }

        return { x: panelLeft, y: panelTop };
    }

    // 添加日志到指定插件面板
    function addPluginLog(pluginId, message) {
        const plugin = registeredPlugins[pluginId];
        if (!plugin) {
            console.warn(`[MYTools] 未找到插件ID ${pluginId}`);
            return;
        }

        // 查找指定插件的面板
        const panel = document.getElementById(`mytools-plugin-panel-${plugin.stableId}`);
        if (!panel) {
            // console.warn(`[MYTools] 未找到插件面板 ${plugin.stableId}`);
            return;
        }

        const logsContainer = panel.querySelector('.mytools-plugin-logs-container');
        if (!logsContainer) {
            // console.warn(`[MYTools] 未找到插件 ${plugin.stableId} 的日志容器`);
            return;
        }

        const time = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.textContent = `[${time}] ${message}`;
        logsContainer.appendChild(logEntry);
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }

    // 清空指定插件日志
    function clearPluginLogs(pluginId) {
        const plugin = registeredPlugins[pluginId];
        if (!plugin) {
            console.warn(`[MYTools] 未找到插件ID ${pluginId}`);
            return;
        }

        const panel = document.getElementById(`mytools-plugin-panel-${plugin.stableId}`);
        if (!panel) return;

        const logsContainer = panel.querySelector('.mytools-plugin-logs-container');
        if (logsContainer) {
            logsContainer.innerHTML = '';
        }
    }

    // 暴露公共接口
    unsafeWindow.MYTools = {
        sendCustomMessage,
        sendActionMessage,
        getCurrentSocket: () => currentSocket,
        getUserInfo: () => userInfo,
        isReady: () => isUIReady && isWSReady && userInfo !== null,
        // 添加插件注册接口
        registerPluginIcon,
        registerPluginPanel,
        registerPluginStatusBar,
        registerMessageHandler,
        registerSendMessageHandler,
        // 添加插件日志接口
        addPluginLog,
        clearPluginLogs
    };

    // 初始化拦截器
    initWebSocketInterceptor();

    // 页面加载完成后创建UI
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
    } else {
        createUI();
    }

    console.log('[MYTools] 已加载，点击悬浮按钮进行配置');

})();