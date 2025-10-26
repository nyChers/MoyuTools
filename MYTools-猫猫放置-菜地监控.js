// ==UserScript==
// @name         MYTools-猫猫放置-菜地监控
// @namespace    http://tampermonkey.net/
// @version      0.0.2
// @description  为猫猫放置游戏提供菜地监控功能
// @author       miaoaim over Lingma
// @match        *://*moyu-idle.com/*
// @match        *://www.moyu-idle.com/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    let pluginId = null;
    // 添加菜地数据数组，保存每块地的状态数据
    let farmPlotsData = Array(9).fill(null);
    // 添加每块地的种子设置
    let plotSeedSettings = Array(9).fill(null);

    // 全局资源映射表，包含种子ID与显示资源、中文名称的对应关系
    const resourceMap = {
        'mushroomSeed': { type: 'emoji', value: '🍄', name: '蘑菇' }, // 蘑菇
        'berrySeed': { type: 'image', value: 'https://moyu-idle.com/_nuxt/resource_berry.BokXoDvC.png', name: '浆果' }, // 浆果
        'grapeSeed': { type: 'emoji', value: '🍇', name: '葡萄' }, //葡萄
        'ryeSeed': { type: 'image', value: 'https://moyu-idle.com/_nuxt/resource_rye.CJeIWR45.png', name: '黑麦' }, // 黑麦
        'dawnBlossomSeed': { type: 'image', value: 'https://moyu-idle.com/_nuxt/resource_dawnBlossom.BuPII5XY.png', name: '晨露花' }, // 晨露花
        'windBellHerbSeed': { type: 'image', value: 'https://moyu-idle.com/_nuxt/resource_windBellHerb.DpHYb8ey.png', name: '风铃草' }, // 风铃草
    };

    // 配置项
    let config = {
        autoReplant: true,     // 村长的神奇补种：打开、关闭，二选一；默认打开
        useFertilizer: false,   // 有屎就用：勾选框；默认勾选
        replantCrops: false,    // 铲除换种：打开、关闭，二选一；默认关闭
        autoHarvest: true,     // 自动收获：打开、关闭，二选一；默认打开
        autoPlant: true,       // 自动补种：打开、关闭，二选一；默认打开
        monitorInterval: 180,  // 监控周期：数字输入框，可输入和加减，单位秒；默认180
        monitorStatus: 0       // 启动监控：按钮，绿色；点击后按监控周期调用监控函数，按钮变成红色停止监控；默认0(停止)
    };

    let monitorIntervalId = null; // 监控定时器ID

    // 等待MYTools加载完成
    function waitForMYTools(callback) {
        const checkInterval = setInterval(() => {
            if (unsafeWindow.MYTools) {
                clearInterval(checkInterval);
                callback();
            }
        }, 100);
    }

    // 初始化插件
    function initPlugin() {
        // 加载保存的配置
        loadConfig();

        // 注册插件图标
        pluginId = unsafeWindow.MYTools.registerPluginIcon(
            '🌱', // 使用幼苗emoji作为图标
            '菜地监控'
        );

        // 创建面板内容 - 3x3九宫格布局
        const panelContent = createFarmPanelContent();

        // 注册插件面板
        unsafeWindow.MYTools.registerPluginPanel(
            pluginId,
            panelContent,
            (panel) => {
                // 面板创建回调函数
                setupFarmPanel(panel);
            }
        );

        // 注册状态栏内容
        unsafeWindow.MYTools.registerPluginStatusBar(
            pluginId,
            '<div style="font-size:12px;padding:0 5px;display:flex;align-items:center;"><button id="status-bar-refresh-btn" style="background:transparent;border:none;color:white;font-size:20px;cursor:pointer;margin-right:5px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;" title="手动刷新">🔄</button>菜地</div>',
            (panel) => {
                // 状态栏创建回调函数
                const refreshBtn = panel.querySelector('#status-bar-refresh-btn');
                if (refreshBtn) {
                    refreshBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        refreshFarmPlotsData();
                    });
                }
            }
        );

        unsafeWindow.MYTools.registerSendMessageHandler(/.*farm:plot.*/, (type, payload, originalData) => {
            console.debug(`[菜地监控] 发送消息: 类型 ${type}, 数据 `, payload);
        });

        // 监听菜地消息
        unsafeWindow.MYTools.registerMessageHandler(/.*farm:plot.*/, (type, payload, originalData) => {
            let res = "success"
            if (!type.includes('success')) {
                res = 'failed';
                console.error(`[菜地监控] 菜地失败消息: 类型 ${type}, 数据 `, payload);
                return;
            }
            console.debug(`[菜地监控] 接收消息: 类型 ${type}, 数据 `, payload);
            switch (type) {
                case 'data:farm:plots:success':
                    // 处理菜地数据
                    updateFarmPlotsData(payload.data.list);
                    break;
                case 'data:farm:plot:autoReplant:success':
                case 'data:farm:plot:harvest:success':
                case 'data:farm:plot:plant:success':
                case 'data:farm:plot:shovel:success':
                    updateOneFarmPlotsData(payload.data.plot);
                    // 收获菜地数据成功
                    break;
                case 'farm:plots:success':
                case 'farm:plot:autoReplant:success':
                case 'farm:plot:harvest:success':
                case 'farm:plot:plant:success':
                case 'farm:plot:shovel:success':
                    break;
                default:
                    // 其他消息处理
                    console.debug(`[菜地监控] 未知消息: 类型 ${type}, 数据 `, payload);
                    break;

            }
            // 更新UI显示
            updateFarmPlotsDisplay();
        });

        // 启动监听的时候，添加监听数据刷新事件
        window.addEventListener('farmPlotDataUpdated', monitorPlotAction);
        if (config.monitorStatus == 1) {
            startMonitor();
        }
    }

    // 加载配置
    function loadConfig() {
        config.autoReplant = GM_getValue('farm_autoReplant', true);
        config.useFertilizer = GM_getValue('farm_useFertilizer', false);
        config.replantCrops = GM_getValue('farm_replantCrops', false);
        config.autoHarvest = GM_getValue('farm_autoHarvest', true);
        config.autoPlant = GM_getValue('farm_autoPlant', true);
        config.monitorInterval = GM_getValue('farm_monitorInterval', 180);
        config.monitorStatus = GM_getValue('farm_monitorStatus', 0);
        // 加载每块地的种子设置
        plotSeedSettings = GM_getValue('farm_plotSeedSettings', Array(9).fill(null));
        console.debug('[菜地监控] 加载配置: ', config)
        console.debug('[菜地监控] 种子配置: ', plotSeedSettings)
    }

    // 保存配置
    function saveConfig() {
        GM_setValue('farm_autoReplant', config.autoReplant);
        GM_setValue('farm_useFertilizer', config.useFertilizer);
        GM_setValue('farm_replantCrops', config.replantCrops);
        GM_setValue('farm_autoHarvest', config.autoHarvest);
        GM_setValue('farm_autoPlant', config.autoPlant);
        GM_setValue('farm_monitorInterval', config.monitorInterval);
        GM_setValue('farm_monitorStatus', config.monitorStatus);
        // 保存每块地的种子设置
        GM_setValue('farm_plotSeedSettings', plotSeedSettings);
    }

    function updateOneFarmPlotsData(data) {
        if (!data) {
            return;
        }
        const plotIndex = data.plotIndex;
        if (!farmPlotsData[plotIndex]) {
            farmPlotsData[plotIndex] = {};
        }
        farmPlotsData[plotIndex].data = data;
        farmPlotsData[plotIndex].state = 'ready';
        // console.debug(`[菜地监控] 菜地数据 ${plotIndex}: `, farmPlotsData[plotIndex]);

        // 更新种子设置 - 只在当前地块未设置种子时更新
        if (!plotSeedSettings[plotIndex] && data.seedId) {
            plotSeedSettings[plotIndex] = data.seedId;
            // 更新按钮图标
            const button = document.querySelector(`.plot-seed-setting-btn[data-plot-id="${plotIndex}"]`);
            updatePlotSeedButtonIcon(button, data.seedId);
        }

        // 发送田地数据刷新事件（带上田地id）
        window.dispatchEvent(new CustomEvent('farmPlotDataUpdated', { detail: { plotId: plotIndex } }));
    }

    // 解析菜地数据
    function updateFarmPlotsData(data) {
        // 根据返回数据填充对应的地块
        if (data) {
            data.forEach(plot => {
                updateOneFarmPlotsData(plot)
            });
        }
    }

    // 更新菜地显示
    function updateFarmPlotsDisplay() {
        const farmGrid = document.getElementById('farm-grid');
        if (!farmGrid) return;

        const farmPlots = farmGrid.querySelectorAll('.farm-plot');
        farmPlots.forEach((plot, index) => {
            const plotData = farmPlotsData[index]?.data;
            const container = plot.querySelector('.crop-image-container');

            // 清除之前的内容
            if (container) {
                container.innerHTML = '';
            }

            // 根据地块状态更新显示和提示信息
            if (plotData && plotData.state === 'GROWING') {
                // 显示作物图标（这里使用种子ID作为示例）
                createCropElement(plotData.seedId, container);

                // 更新边框颜色为黄色（生长期）
                plot.style.border = '2px solid #FFD700';

                // 生长期提示
                plot.title = '点击铲除';
                plot.classList.remove('cursor-sickle', 'cursor-seed');
                plot.classList.add('cursor-shovel');
            } else if (plotData && plotData.state === 'READY') {
                // 显示作物图标
                createCropElement(plotData.seedId, container);

                // 更新边框颜色为绿色（可收获）
                plot.style.border = '2px solid #00FF00';

                // 可收获状态提示
                plot.title = '点击收获';
                plot.classList.remove('cursor-shovel', 'cursor-seed');
                plot.classList.add('cursor-sickle');
            } else if (plotData && plotData.state === 'EMPTY') {
                // 空地状态
                plot.style.border = '2px solid red';

                // 空地状态提示
                plot.title = '点击播种';
                plot.classList.remove('cursor-shovel', 'cursor-sickle');
                plot.classList.add('cursor-seed');
            } else {
                // 默认状态（未知状态）提示
                plot.title = '';
                plot.classList.remove('cursor-shovel', 'cursor-sickle', 'cursor-seed');
                plot.style.cursor = 'default';
            }
        });
    }

    // 根据种子ID创建作物显示元素（支持emoji和图片）
    function createCropElement(seedId, container) {
        const resource = getResourceBySeedId(seedId);

        if (resource.type === 'emoji') {
            const cropEmoji = document.createElement('div');
            cropEmoji.textContent = resource.value;
            cropEmoji.style.width = '50%';
            cropEmoji.style.height = '50%';
            cropEmoji.style.display = 'flex';
            cropEmoji.style.alignItems = 'center';
            cropEmoji.style.justifyContent = 'center';
            cropEmoji.style.fontSize = '24px';
            cropEmoji.style.margin = 'auto';
            container.appendChild(cropEmoji);
        } else if (resource.type === 'image') {
            const cropImage = document.createElement('img');
            cropImage.src = resource.value;
            cropImage.style.width = '50%';
            cropImage.style.height = '50%';
            cropImage.style.objectFit = 'contain';
            cropImage.style.margin = 'auto';
            container.appendChild(cropImage);
        }
    }

    // 根据种子ID返回对应的资源（emoji或图片）
    function getResourceBySeedId(seedId) {
        return resourceMap[seedId] || { type: 'emoji', value: '🌱', name: '未知作物' };
    }

    // 根据种子ID获取作物中文名称
    function getSeedNameBySeedId(seedId) {
        const resource = getResourceBySeedId(seedId);
        return resource.name;
    }

    // 创建菜地监控面板内容
    function createFarmPanelContent() {
        // 创建隐藏的光标元素
        const cursorStyles = `
            <style>
                .cursor-shovel { cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><text x="0" y="20" font-size="20">❌</text></svg>') 12 12, auto !important; }
                .cursor-sickle { cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><text x="0" y="20" font-size="20">🤏</text></svg>') 12 12, auto !important; }
                .cursor-seed { cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><text x="0" y="20" font-size="20">🌱</text></svg>') 12 12, auto !important; }
            </style>
        `;

        return `
            ${cursorStyles}
            <div id="farm-grid" style="display: grid; grid-template-columns: repeat(3, 1fr); grid-gap: 10px; margin-bottom: 15px;">
                ${Array(9).fill('').map((_, index) => `
                    <div class="farm-plot" data-plot-id="${index}" style="aspect-ratio: 1; display: flex; align-items: center; justify-content: center; border: 2px solid red; border-radius: 8px; background: rgba(0,0,0,0.2); position: relative;" title="点击播种">
                        <div class="crop-image-container" style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">
                        </div>
                        <div class="plot-seed-setting-btn" data-plot-id="${index}" style="position: absolute; bottom: 2px; right: 2px; width: 30px; height: 30px; background: rgba(0,0,0,0.5); border: 1px solid #3498db; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 18px;" title="种子设置">
                            🌱
                        </div>
                    </div>
                `).join('')}
            </div>
            <div id="farm-config" style="border-top: 1px solid #3498db; padding-top: 15px;">
                <div style="margin-bottom: 10px; display: flex; gap: 8px;">
                    <button id="auto-replant-toggle-btn" style="flex: 2; padding: 4px 8px; font-size: 12px; border: 1px solid transparent; cursor: pointer; background: rgba(100,181,246,0.3); color: #64B5F6; border: 1px solid #64B5F6;">打开村长的神奇补种</button>
                    <button id="fertilizer-toggle-btn" style="flex: 1; padding: 4px 8px; font-size: 12px; border: 1px solid transparent; cursor: pointer; background: rgba(129,199,132,0.3); color: #81C784; border: 1px solid #81C784;">有屎就用</button>
                    <button id="replant-crops-toggle-btn" style="flex: 1; padding: 4px 8px; font-size: 12px; border: 1px solid transparent; cursor: pointer; background: rgba(129,199,132,0.3); color: #81C784; border: 1px solid #81C784;">铲除换种</button>
                </div>
                <div style="margin-bottom: 10px; display: flex;">
                    <button id="auto-harvest-toggle-btn" style="flex: 1; padding: 4px 8px; font-size: 12px; border: 1px solid transparent; cursor: pointer; background: rgba(129,199,132,0.3); color: #81C784; border: 1px solid #81C784; margin-right: 5px;">自动收获</button>
                    <button id="auto-plant-toggle-btn" style="flex: 1; padding: 4px 8px; font-size: 12px; border: 1px solid transparent; cursor: pointer; background: rgba(129,199,132,0.3); color: #81C784; border: 1px solid #81C784; margin-left: 5px;">自动补种</button>
                </div>
                <div style="margin-bottom: 10px; display: flex; align-items: center;">
                    <button id="refresh-farm-plots-btn" style="width: 30px; height: 30px; cursor: pointer; background: transparent; color: white; border: none; border-radius: 4px; margin-right: 5px; font-size: 20px; display: flex; align-items: center; justify-content: center;" title="手动刷新">🔄</button>
                    <button id="monitor-toggle-btn" style="flex: 1; padding: 8px; cursor: pointer; background: #27ae60; color: white; border: none; border-radius: 4px;">
                        启动监控
                    </button>
                    <div style="display: flex; align-items: center; margin-left: 10px;">
                        <span style="margin-right: 5px;">监控周期</span>
                        <input type="number" id="monitor-interval-input" value="180" min="1" style="width: 60px; background: rgba(255,255,255,0.1); color: white; border: 1px solid #3498db; text-align: center;">
                        <span style="margin-left: 3px;">秒</span>
                    </div>
                </div>
            </div>
        `;
    }

    // 设置菜地监控面板
    function setupFarmPanel(panel) {
        refreshFarmPlotsData();
        // 可以在这里添加面板事件监听器
        const farmPlots = panel.querySelectorAll('.farm-plot');

        farmPlots.forEach(plot => {
            plot.addEventListener('click', () => {
                const plotId = parseInt(plot.dataset.plotId);
                const plotData = farmPlotsData[plotId]?.data;

                // 根据地块状态执行相应操作
                if (plotData && plotData.state === 'GROWING') {
                    // 铲除作物前添加二次确认
                    const seedName = getSeedNameBySeedId(plotData.seedId);
                    if (confirm(`确定要铲除菜地 ${plotId + 1} 的${seedName}吗？`)) {
                        // shovelFarmPlot(plotId);
                    }
                } else if (plotData && plotData.state === 'READY') {
                    // 收获作物
                    harvestFarmPlot(plotId);
                } else if (plotData && plotData.state === 'EMPTY') {
                    // 种植作物
                    plantFarmPlot(plotId);
                } else {
                    // 如果没有数据或者状态未知，什么都不做
                }
            });
        });

        // 设置配置面板事件监听器
        setupConfigPanel(panel);

        // 设置每块地的种子设置按钮事件
        setupPlotSeedSetting(panel);
    }

    // 设置每块地的种子设置
    function setupPlotSeedSetting(panel) {
        const seedSettingButtons = panel.querySelectorAll('.plot-seed-setting-btn');
        seedSettingButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                e.stopPropagation();
                const plotId = parseInt(button.dataset.plotId);
                showSeedSelectionDropdown(button, plotId);
            });
        });

        // 初始化时更新所有地块的按钮图标
        updateAllPlotSeedButtonIcons();
    }

    // 更新所有地块种子设置按钮图标
    function updateAllPlotSeedButtonIcons() {
        for (let i = 0; i < plotSeedSettings.length; i++) {
            const button = document.querySelector(`.plot-seed-setting-btn[data-plot-id="${i}"]`);
            if (button) {
                updatePlotSeedButtonIcon(button, plotSeedSettings[i]);
            }
        }
    }

    // 显示种子选择下拉框
    function showSeedSelectionDropdown(button, plotId) {
        // 移除已存在的下拉框
        const existingDropdown = document.querySelector('.seed-selection-dropdown');
        if (existingDropdown) {
            existingDropdown.remove();
        }

        // 创建下拉框
        const dropdown = document.createElement('div');
        dropdown.className = 'seed-selection-dropdown';
        dropdown.style.cssText = `
            position: absolute;
            bottom: 25px;
            right: 0;
            width: 120px;
            background: rgba(25, 35, 45, 0.95);
            border: 1px solid #3498db;
            border-radius: 4px;
            z-index: 10001;
            padding: 5px;
        `;

        // 添加选项
        const seeds = Object.keys(resourceMap);
        seeds.forEach(seedId => {
            const seedInfo = resourceMap[seedId];
            const option = document.createElement('div');
            option.style.cssText = `
                padding: 5px;
                cursor: pointer;
                display: flex;
                align-items: center;
            `;

            // 显示种子图标
            const icon = document.createElement('span');
            icon.style.cssText = 'margin-right: 5px; font-size: 14px;';
            if (seedInfo.type === 'emoji') {
                icon.textContent = seedInfo.value;
            } else {
                // 创建图片元素而不是使用默认图标
                const img = document.createElement('img');
                img.src = seedInfo.value;
                img.style.width = '14px';
                img.style.height = '14px';
                img.style.objectFit = 'contain';
                icon.appendChild(img);
            }

            const name = document.createElement('span');
            name.textContent = seedInfo.name;

            option.appendChild(icon);
            option.appendChild(name);

            option.addEventListener('click', (e) => {
                e.stopPropagation();
                // 设置该地块的种子
                plotSeedSettings[plotId] = seedId;
                saveConfig();

                // 更新按钮图标
                updatePlotSeedButtonIcon(button, seedId);

                // 移除下拉框
                dropdown.remove();
            });

            dropdown.appendChild(option);
        });

        // 添加"无设置"选项
        const unsetOption = document.createElement('div');
        unsetOption.style.cssText = `
            padding: 5px;
            cursor: pointer;
            color: #aaa;
            border-top: 1px solid #3498db;
            margin-top: 3px;
        `;
        unsetOption.textContent = '无设置';
        unsetOption.addEventListener('click', (e) => {
            e.stopPropagation();
            plotSeedSettings[plotId] = 'none'; // 使用'none'而不是null来区分未设置
            saveConfig();

            // 更新按钮图标为默认
            updatePlotSeedButtonIcon(button, 'none');

            // 移除下拉框
            dropdown.remove();
        });
        dropdown.appendChild(unsetOption);

        // 添加到按钮旁边
        button.parentElement.appendChild(dropdown);

        // 点击其他地方关闭下拉框
        const closeDropdown = (e) => {
            if (!dropdown.contains(e.target) && e.target !== button) {
                dropdown.remove();
                document.removeEventListener('click', closeDropdown);
            }
        };

        setTimeout(() => {
            document.addEventListener('click', closeDropdown);
        }, 0);
    }

    // 更新地块种子设置按钮图标
    function updatePlotSeedButtonIcon(button, seedId) {
        // 修复：检查button是否存在
        if (!button) return;

        // 处理'none'状态
        if (seedId === 'none') {
            button.textContent = '🚫';
            return;
        }

        if (seedId) {
            const resource = getResourceBySeedId(seedId);
            if (resource.type === 'emoji') {
                button.textContent = resource.value;
            } else {
                // 对于图片资源，创建img元素
                button.innerHTML = '';
                const img = document.createElement('img');
                img.src = resource.value;
                img.style.width = '24px';
                img.style.height = '24px';
                img.style.objectFit = 'contain';
                button.appendChild(img);
            }
        } else {
            button.textContent = '🌱';
        }
    }

    // 设置配置面板
    function setupConfigPanel(panel) {
        // 获取配置元素
        const autoReplantButton = panel.querySelector('#auto-replant-toggle-btn');
        const fertilizerButton = panel.querySelector('#fertilizer-toggle-btn');
        const replantCropsButton = panel.querySelector('#replant-crops-toggle-btn');
        const autoHarvestButton = panel.querySelector('#auto-harvest-toggle-btn');
        const autoPlantButton = panel.querySelector('#auto-plant-toggle-btn');
        const monitorIntervalInput = panel.querySelector('#monitor-interval-input');
        const monitorToggleBtn = panel.querySelector('#monitor-toggle-btn');
        const refreshFarmPlotsBtn = panel.querySelector('#refresh-farm-plots-btn');

        // 初始化配置元素值
        updateAutoReplantButton(autoReplantButton, config.autoReplant);
        updateFertilizerButton(fertilizerButton, config.useFertilizer);
        updateReplantCropsButton(replantCropsButton, config.replantCrops);
        updateAutoHarvestButton(autoHarvestButton, config.autoHarvest);
        updateAutoPlantButton(autoPlantButton, config.autoPlant);
        monitorIntervalInput.value = config.monitorInterval;
        updateMonitorButtonStyle(monitorToggleBtn, config.monitorStatus);

        // 添加事件监听器
        autoReplantButton.addEventListener('click', () => {
            config.autoReplant = !config.autoReplant;
            saveConfig();
            updateAutoReplantButton(autoReplantButton, config.autoReplant);
        });

        // fertilizerButton.addEventListener('click', () => {
        //     config.useFertilizer = !config.useFertilizer;
        //     saveConfig();
        //     updateFertilizerButton(fertilizerButton, config.useFertilizer);
        // });

        replantCropsButton.addEventListener('click', () => {
            config.replantCrops = !config.replantCrops;
            saveConfig();
            updateReplantCropsButton(replantCropsButton, config.replantCrops);
        });

        autoHarvestButton.addEventListener('click', () => {
            config.autoHarvest = !config.autoHarvest;
            saveConfig();
            updateAutoHarvestButton(autoHarvestButton, config.autoHarvest);
        });

        autoPlantButton.addEventListener('click', () => {
            config.autoPlant = !config.autoPlant;
            saveConfig();
            updateAutoPlantButton(autoPlantButton, config.autoPlant);
        });

        monitorIntervalInput.addEventListener('change', () => {
            const value = parseInt(monitorIntervalInput.value);
            if (!isNaN(value) && value > 0) {
                config.monitorInterval = value;
                saveConfig();
                // 值修改后重置监控定时器
                if (config.monitorStatus === 1) {
                    stopMonitor();
                    startMonitor();
                }
            } else {
                monitorIntervalInput.value = config.monitorInterval;
            }
        });

        monitorToggleBtn.addEventListener('click', () => {
            if (config.monitorStatus === 0) {
                // 启动监控
                config.monitorStatus = 1;
                startMonitor();
            } else {
                // 停止监控
                config.monitorStatus = 0;
                stopMonitor();
            }
            saveConfig();
            updateMonitorButtonStyle(monitorToggleBtn, config.monitorStatus);
        });

        // 添加刷新按钮事件监听器
        refreshFarmPlotsBtn.addEventListener('click', () => {
            refreshFarmPlotsData();
        });
    }

    // 更新监控按钮样式
    function updateMonitorButtonStyle(button, status) {
        if (status === 0) {
            // 停止状态 - 绿色
            button.style.background = '#27ae60';
            button.textContent = '启动监控';
        } else {
            // 运行状态 - 红色
            button.style.background = '#e74c3c';
            button.textContent = '停止监控';
        }
    }

    // 更新自动补种按钮样式
    function updateAutoReplantButton(button, isActive) {
        if (isActive) {
            // 打开状态 - 绿色
            button.style.background = 'rgba(129,199,132,0.3)';
            button.style.color = '#81C784';
            button.style.border = '1px solid #81C784';
            button.textContent = '打开村长的神奇补种';
        } else {
            // 关闭状态 - 灰色
            button.style.background = 'rgba(255,255,255,0.1)';
            button.style.color = '#aaa';
            button.style.border = '1px solid transparent';
            button.textContent = '关闭村长的神奇补种';
        }
    }

    // 更新肥料按钮样式
    function updateFertilizerButton(button, isActive) {
        if (isActive) {
            // 使用肥料时显示绿色
            button.style.background = 'rgba(129,199,132,0.3)';
            button.style.color = '#81C784';
            button.style.border = '1px solid #81C784';
        } else {
            // 不使用肥料时显示灰色
            button.style.background = 'rgba(255,255,255,0.1)';
            button.style.color = '#aaa';
            button.style.border = '1px solid transparent';
        }
    }

    // 更新铲除换种按钮样式
    function updateReplantCropsButton(button, isActive) {
        if (isActive) {
            // 打开状态 - 绿色
            button.style.background = 'rgba(129,199,132,0.3)';
            button.style.color = '#81C784';
            button.style.border = '1px solid #81C784';
        } else {
            // 关闭状态 - 灰色
            button.style.background = 'rgba(255,255,255,0.1)';
            button.style.color = '#aaa';
            button.style.border = '1px solid transparent';
        }
    }

    // 更新自动收获按钮样式
    function updateAutoHarvestButton(button, isActive) {
        if (isActive) {
            // 打开状态 - 绿色
            button.style.background = 'rgba(129,199,132,0.3)';
            button.style.color = '#81C784';
            button.style.border = '1px solid #81C784';
        } else {
            // 关闭状态 - 灰色
            button.style.background = 'rgba(255,255,255,0.1)';
            button.style.color = '#aaa';
            button.style.border = '1px solid transparent';
        }
    }

    // 更新自动补种按钮样式
    function updateAutoPlantButton(button, isActive) {
        if (isActive) {
            // 打开状态 - 绿色
            button.style.background = 'rgba(129,199,132,0.3)';
            button.style.color = '#81C784';
            button.style.border = '1px solid #81C784';
        } else {
            // 关闭状态 - 灰色
            button.style.background = 'rgba(255,255,255,0.1)';
            button.style.color = '#aaa';
            button.style.border = '1px solid transparent';
        }
    }

    // 监控菜地执行
    function monitorPlotAction(event) {
        const plotId = event.detail.plotId;
        const plotData = farmPlotsData[plotId]?.data;

        if (!plotData || config.monitorStatus != 1) return;

        // 自动收获
        if (config.autoHarvest && plotData.state === 'READY') {
            harvestFarmPlot(plotId);
            return;
        }

        // 设置村长补种
        if (plotData.autoReplant != config.autoReplant) {
            setAutoReplant(plotId, config.autoReplant);
            return;
        }

        // 自动补种
        if (config.autoPlant && plotData.state === 'EMPTY') {
            plantFarmPlot(plotId);
            return;
        }

        // 铲除换种
        if (config.replantCrops && plotData.state === 'GROWING') {
            shovelFarmPlot(plotId);
        }
    }

    // 启动监控
    function startMonitor() {
        stopMonitor(); // 先清除现有的定时器
        refreshFarmPlotsData();
        monitorIntervalId = setInterval(() => {
            refreshFarmPlotsData();
        }, config.monitorInterval * 1000);
    }

    // 停止监控
    function stopMonitor() {
        if (monitorIntervalId) {
            clearInterval(monitorIntervalId);
            monitorIntervalId = null;
        }
    }

    // 刷新全部菜地数据
    function refreshFarmPlotsData() {
        unsafeWindow.MYTools.sendActionMessage('farm:plots', {});
        addLog('刷新菜地数据 ...');
    }

    // 设置村长自动补种
    function setAutoReplant(plotId, isActive) {
        unsafeWindow.MYTools.sendActionMessage('farm:plot:autoReplant', { "plotIndex": plotId, "value": isActive });
        addLog(`设置菜地 ${plotId + 1} 的自动补种为 ${isActive ? '打开' : '关闭'} ...`);
    }

    // 收获菜地
    function harvestFarmPlot(plotId) {
        unsafeWindow.MYTools.sendActionMessage('farm:plot:harvest', { "plotIndex": plotId });
        addLog(`开始收获菜地 ${plotId + 1} ...`);
    }

    // 铲除菜地
    function shovelFarmPlot(plotId) {
        unsafeWindow.MYTools.sendActionMessage('farm:plot:shovel', { "plotIndex": plotId });
        addLog(`开始铲除菜地 ${plotId + 1} ...`);
    }

    // 种植作物到菜地
    function plantFarmPlot(plotId) {
        // 获取该地块设置的种子
        let seed = plotSeedSettings[plotId];

        // 如果仍然没有种子，则不执行种植操作
        if (!seed || seed === 'none') {
            addLog(`菜地 ${plotId + 1} 未设置种子，跳过种植 ...`);
            return;
        }

        let fertilizers = [];
        if (config.useFertilizer) {
            // 这里可以添加肥料逻辑
        }

        _plantFarmPlot(plotId, seed, fertilizers);
    }

    // 种植作物到菜地
    function _plantFarmPlot(plotId, seed, fertilizers = []) {
        const messageData = {
            "plotIndex": plotId,
            "seedId": seed
        };

        // 如果提供了肥料，则添加到消息中
        if (fertilizers && fertilizers.length > 0) {
            messageData.fertilizers = fertilizers;
        }

        unsafeWindow.MYTools.sendActionMessage('farm:plot:plant', messageData);
        const seedName = getSeedNameBySeedId(seed);
        addLog(`开始在菜地 ${plotId + 1} 种植 ${seedName} ...`);
    }

    // 添加日志到面板
    function addLog(message) {
        // 获取插件ID
        if (pluginId !== null && unsafeWindow.MYTools?.addPluginLog) {
            unsafeWindow.MYTools.addPluginLog(pluginId, message);
        } else {
            console.warn('[菜地监控] 无法添加日志，插件系统未就绪');
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