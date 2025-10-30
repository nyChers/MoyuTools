// ==UserScript==
// @name         MYTools-猫猫放置-快捷指令
// @namespace    http://tampermonkey.net/
// @version      0.0.2
// @description  为猫猫放置游戏提供快捷指令功能
// @author       miaoaim over Lingma
// @match        *://*moyu-idle.com/*
// @match        *://www.moyu-idle.com/*
// @downloadURL  https://github.com/nyChers/MoyuTools/blob/master/MYTools-%E7%8C%AB%E7%8C%AB%E6%94%BE%E7%BD%AE-%E5%BF%AB%E6%8D%B7%E6%8C%87%E4%BB%A4.js
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    let pluginId = null;

    // 收获箱状态管理
    let harvestBoxState = {
        ready: false,
        data: null
    };

    let harvestClaimStat = {
        done: false,
        result: ''
    };

    // 等待MYTools加载完成
    function waitForMYTools(callback) {
        const checkInterval = setInterval(() => {
            if (unsafeWindow.MYTools && unsafeWindow.MYTools.isReady()) {
                clearInterval(checkInterval);
                callback();
            }
        }, 100);
    }

    // 通用异步等待函数
    function waitForCondition(getter, checkInterval = 100, timeout = 10000) {
        return new Promise((resolve, reject) => {
            // 设置超时
            const timeoutId = setTimeout(() => {
                reject(new Error('等待超时'));
            }, timeout);

            // 轮询检查条件
            const checkIntervalId = setInterval(() => {
                const value = getter();
                if (value) {
                    clearTimeout(timeoutId);
                    clearInterval(checkIntervalId);
                    resolve(value);
                }
            }, checkInterval);
        });
    }

    // 初始化插件
    function initPlugin() {
        // 注册插件图标
        pluginId = unsafeWindow.MYTools.registerPluginIcon(
            '⚡', // 使用闪电emoji作为图标
            '快捷指令'
        );

        // 创建面板内容 - 快捷指令按钮
        const panelContent = `
            <div style="margin-bottom: 15px;">
                <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                    <button id="quick-harvest-all" style="background: #3498db; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">一键领取收获箱</button>
                </div>
            </div>
        `;

        const panelStatusBar = `<button id="quick-harvest-all" style="background: #3498db; color: white; border: none; border-radius: 4px; cursor: pointer; padding: 2px 6px; font-size: 12px; height: 24px; margin: 0 2px;">收</button>`

        // 注册插件面板
        unsafeWindow.MYTools.registerPluginPanel(
            pluginId,
            panelContent,
            (panel) => {
                // 面板创建回调函数，在这里添加事件监听器
                addPanelEventListeners(panel);
            }
        );

        // 注册状态栏内容
        unsafeWindow.MYTools.registerPluginStatusBar(
            pluginId,
            panelStatusBar,
            (panel) => {
                addPanelEventListeners(panel);
            }
        );

        // 监听收获箱列表消息
        unsafeWindow.MYTools.registerMessageHandler('data:harvestBox:list:success', (type, payload, originalData) => {
            // 直接解析收获箱数据
            if (payload && payload.data && payload.data.list) {
                harvestBoxState.data = payload.data.list.filter(item => !item.claimed);
            } else {
                harvestBoxState.data = [];
            }
            harvestBoxState.ready = true;
        });

        // 监听收获箱领取消息（使用正则表达式统一监听）
        unsafeWindow.MYTools.registerMessageHandler(/^harvestBox:claim.*/, (type, payload, originalData) => {
            // 通过type判断是否成功
            if (type.includes('success')) {
                harvestClaimStat.result = 'success';
            } else {
                harvestClaimStat.result = originalData;
            }
            harvestClaimStat.done = true;
        });
    }

    // 添加面板事件监听器
    function addPanelEventListeners(panel) {
        // 一键领取收获箱
        panel.querySelector('#quick-harvest-all')?.addEventListener('click', () => {
            quickHarvestAll();
        });
    }

    // 一键领取收获箱
    async function quickHarvestAll() {
        addLog('开始处理收获箱...');

        // 只有当状态未就绪时才发送刷新消息
        if (!harvestBoxState.ready || harvestBoxState.data.length == 0) {
            addLog('正在查询收获箱...');
            // 重置状态
            harvestBoxState.ready = false;
            harvestBoxState.data = null;

            // 发送查询收获箱消息
            unsafeWindow.MYTools.sendActionMessage('harvestBox:list', { includeClaimed: false, take: 100 });
        }

        // 等待数据准备就绪
        try {
            await waitForCondition(() => harvestBoxState.ready);
            await processHarvestBoxItems();
        } catch (error) {
            addLog('操作失败: ' + error.message);
        }
    }

    // 处理收获箱项目
    async function processHarvestBoxItems() {
        if (!harvestBoxState.data) {
            addLog('收获箱数据为空');
            return;
        }

        const unclaimedItems = harvestBoxState.data;
        addLog(`找到 ${unclaimedItems.length} 个未领取的收获箱项目`);

        if (unclaimedItems.length === 0) {
            addLog('没有未领取的收获箱项目');
            return;
        }

        // 使用状态机处理每个项目
        for (let i = 0; i < unclaimedItems.length; i++) {
            const item = unclaimedItems[i];
            // addLog(`正在领取项目: ${item.title}`);

            try {
                await claimHarvestBoxItem(item.id);
                addLog(`成功领取项目: ${item.title}`);
            } catch (error) {
                addLog(`领取项目失败: ${item.title} - ${error.message}`);
            }
        }

        addLog('所有收获箱项目领取完成');
    }

    // 领取单个收获箱项目
    async function claimHarvestBoxItem(boxId) {
        // 发送领取消息
        unsafeWindow.MYTools.sendActionMessage('harvestBox:claim', { "boxId": boxId });
        await waitForCondition(() => harvestClaimStat.done);
        if (harvestClaimStat.result !== 'success') {
            throw new Error(harvestClaimStat.result);
        }
        return
    }

    // 添加日志到面板
    function addLog(message) {
        // 获取插件ID
        if (pluginId !== null && unsafeWindow.MYTools?.addPluginLog) {
            unsafeWindow.MYTools.addPluginLog(pluginId, message);
        } else {
            console.warn('[快捷指令] 无法添加日志，插件系统未就绪');
        }
    }

    // 页面加载完成后初始化插件
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            waitForMYTools(initPlugin);
        });
    } else {
        waitForMYTools(initPlugin);
    }
})();