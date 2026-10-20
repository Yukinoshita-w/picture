(function (root) {
  'use strict';

  // Built-in starting points. Each template is intentionally a *structure*, not a finished
  // look: the user replaces the theme and adjusts the canon fields.
  const TEMPLATES = [
    {
      id: 'character-sheet',
      title: '角色设定集',
      summary: '同一个角色，换场景、表情与景别。适合角色设定与连续叙事。',
      theme: '一个主要角色在不同场景中的稳定形象。',
      canon: {
        medium: '数字绘画角色设定',
        palette: [
          { name: '主色', hex: '#b23a22', weight: 0.4 },
          { name: '辅色', hex: '#2f3b45', weight: 0.35 },
          { name: '留白', hex: '#e8e2d6', weight: 0.25 }
        ],
        lighting: { key: '柔和三点布光', ratio: '1:3', direction: '正前方偏上', colorTemp: '5000K' },
        lens: { focal: '85mm', aperture: 'f/2.8', distance: '半身', angle: '平视' },
        composition: { frame: '竖构图 3:4', placement: '主体居中', negativeSpace: '上方留出标题区', horizon: '无' },
        grade: { contrast: '中等对比', saturation: '自然饱和', shadows: '中性偏暖', highlights: '柔和' },
        material: { render: '干净线稿与平涂', texture: '轻微纸张纹理', finish: '无强高光' },
        terms: { hero: '主角', city: '城市' },
        characterLook: '',
        atmosphere: '清晰、克制、便于识别',
        negative: ['多余肢体', '五官崩坏', '背景杂乱']
      },
      axes: [
        { id: 'scene', label: '场景', values: ['室内', '街道', '自然'] },
        { id: 'shot', label: '景别', values: ['特写', '半身', '全身'] }
      ],
      shots: [
        { code: 'S01', title: '正面半身', beat: '设定', subject: '{{hero}}', action: '正面站立', scene: '纯色背景', detail: '标准表情，展示服装结构', axisValues: { scene: '室内', shot: '半身' } },
        { code: 'S02', title: '侧面特写', beat: '设定', subject: '{{hero}}', action: '侧头看向画面外', scene: '纯色背景', detail: '强调侧脸轮廓与发型', axisValues: { scene: '室内', shot: '特写' } },
        { code: 'S03', title: '场景全身', beat: '应用', subject: '{{hero}}', action: '走在街上', scene: '{{city}}', detail: '展示服装在自然光下的整体效果', axisValues: { scene: '街道', shot: '全身' } }
      ]
    },
    {
      id: 'product-launch',
      title: '产品上市',
      summary: '同一件产品的主图、细节与场景图，用于电商与发布物料。',
      theme: '一件产品在干净布光下的完整展示。',
      canon: {
        medium: '商业产品摄影',
        palette: [
          { name: '产品主色', hex: '#c9762f', weight: 0.4 },
          { name: '背景灰', hex: '#dcd7cc', weight: 0.4 },
          { name: '深色台面', hex: '#2b2a26', weight: 0.2 }
        ],
        lighting: { key: '大面积柔光箱', ratio: '1:2', direction: '左上 45 度', colorTemp: '5500K' },
        lens: { focal: '100mm 微距', aperture: 'f/8', distance: '中近景', angle: '略高于平视' },
        composition: { frame: '方形 1:1', placement: '产品居中偏下', negativeSpace: '上方留标题区', horizon: '无' },
        grade: { contrast: '低对比', saturation: '准确还原', shadows: '通透', highlights: '柔和不溢出' },
        material: { render: '真实摄影', texture: '产品材质清晰', finish: '干净高光' },
        terms: { product: '产品' },
        characterLook: '',
        atmosphere: '干净、可信、有质感',
        negative: ['错误 logo', '变形', '杂乱背景', '水印']
      },
      axes: [
        { id: 'view', label: '视角', values: ['正面', '45 度', '俯视'] },
        { id: 'scene', label: '场景', values: ['纯色棚拍', '深色台面', '生活场景'] }
      ],
      shots: [
        { code: 'S01', title: '正面主图', beat: '主图', subject: '{{product}}', action: '静置展示', scene: '纯色棚拍', detail: '完整外形与比例，无遮挡', axisValues: { view: '正面', scene: '纯色棚拍' } },
        { code: 'S02', title: '45 度细节', beat: '细节', subject: '{{product}}', action: '静置展示', scene: '深色台面', detail: '材质纹理与接缝细节', axisValues: { view: '45 度', scene: '深色台面' } },
        { code: 'S03', title: '使用场景', beat: '场景', subject: '{{product}}', action: '被自然使用', scene: '生活场景', detail: '与环境和手部的比例关系', axisValues: { view: '45 度', scene: '生活场景' } }
      ]
    },
    {
      id: 'picture-book',
      title: '绘本故事',
      summary: '一个故事的连续分镜，画风统一、情绪递进。',
      theme: '一个温柔的小故事，从清晨走到夜晚。',
      canon: {
        medium: '透明水彩绘本插画',
        palette: [
          { name: '晨雾蓝', hex: '#8fa6b8', weight: 0.35 },
          { name: '陶土橙', hex: '#c87b57', weight: 0.3 },
          { name: '纸白', hex: '#f2ede4', weight: 0.35 }
        ],
        lighting: { key: '窗光与天光', ratio: '1:2', direction: '侧逆光', colorTemp: '4500K' },
        lens: { focal: '50mm', aperture: 'f/4', distance: '中景', angle: '平视' },
        composition: { frame: '横构图 4:3', placement: '主体偏左', negativeSpace: '右侧留白', horizon: '略低于中线' },
        grade: { contrast: '柔和低对比', saturation: '低饱和', shadows: '偏暖', highlights: '纸白' },
        material: { render: '手绘水彩', texture: '纸张纤维与颜料沉积', finish: '轻微晕染' },
        characterLook: '',
        atmosphere: '安静、温柔、带一点潮湿感',
        negative: ['照片写实', '3D 渲染', '高饱和', '文字']
      },
      axes: [
        { id: 'time', label: '时间', values: ['清晨', '正午', '黄昏', '夜晚'] },
        { id: 'place', label: '地点', values: ['小屋', '树林', '河边'] }
      ],
      shots: [
        { code: 'S01', title: '醒来', beat: '起', subject: '主角', action: '推开窗户', scene: '小屋', detail: '晨雾从窗口涌进来', axisValues: { time: '清晨', place: '小屋' } },
        { code: 'S02', title: '出发', beat: '承', subject: '主角', action: '背着包走进树林', scene: '树林', detail: '光斑落在肩上', axisValues: { time: '正午', place: '树林' } },
        { code: 'S03', title: '归途', beat: '合', subject: '主角', action: '沿着河边往回走', scene: '河边', detail: '影子被黄昏拉得很长', axisValues: { time: '黄昏', place: '河边' } }
      ]
    },
    {
      id: 'brand-poster',
      title: '品牌海报',
      summary: '同一套版式与配色，替换主题物，用于一组海报。',
      theme: '一组同一版式的品牌海报。',
      canon: {
        medium: '平面设计海报',
        palette: [
          { name: '主色', hex: '#1f2a36', weight: 0.5 },
          { name: '强调色', hex: '#e4704f', weight: 0.2 },
          { name: '底色', hex: '#f4f1ea', weight: 0.3 }
        ],
        lighting: { key: '均匀棚光', ratio: '1:1.5', direction: '正面', colorTemp: '5600K' },
        lens: { focal: '50mm', aperture: 'f/5.6', distance: '中景', angle: '平视' },
        composition: { frame: '竖构图 2:3', placement: '主体居中偏上', negativeSpace: '下方留标题区', horizon: '无' },
        grade: { contrast: '高对比', saturation: '克制', shadows: '深墨色', highlights: '留白' },
        material: { render: '摄影与排版结合', texture: '细腻纸感', finish: '无眩光' },
        characterLook: '',
        atmosphere: '克制、现代、有留白',
        negative: ['杂乱元素', '拼写错误', '过多样式']
      },
      axes: [
        { id: 'theme', label: '主题物', values: ['城市', '自然', '人物'] },
        { id: 'tone', label: '色调', values: ['冷调', '暖调'] }
      ],
      shots: [
        { code: 'S01', title: '城市篇', beat: '系列', subject: '城市天际线', action: '静态构图', scene: '极简背景', detail: '主体压在版面上三分之一', axisValues: { theme: '城市', tone: '冷调' } },
        { code: 'S02', title: '自然篇', beat: '系列', subject: '一片叶子', action: '悬停', scene: '极简背景', detail: '同样的版式与留白', axisValues: { theme: '自然', tone: '暖调' } }
      ]
    },
    {
      id: 'travel-journal',
      title: '旅行日记',
      summary: '同一段旅程的若干画面，胶片质感、时间线清晰。',
      theme: '一次沿海旅行的若干瞬间。',
      canon: {
        medium: '35mm 胶片纪实摄影',
        palette: [
          { name: '海雾灰', hex: '#9aa5a8', weight: 0.4 },
          { name: '日光金', hex: '#d9a441', weight: 0.3 },
          { name: '阴影蓝', hex: '#2c3b45', weight: 0.3 }
        ],
        lighting: { key: '自然日光', ratio: '1:4', direction: '随机', colorTemp: '日光' },
        lens: { focal: '35mm', aperture: 'f/5.6', distance: '中景', angle: '手持平视' },
        composition: { frame: '横构图 3:2', placement: '自然构图', negativeSpace: '保留天空', horizon: '水平' },
        grade: { contrast: '中高对比', saturation: '轻微褪色', shadows: '偏蓝', highlights: '偏暖' },
        material: { render: '真实摄影', texture: '明显胶片颗粒', finish: '轻微漏光' },
        characterLook: '',
        atmosphere: '真实、松弛、有时间感',
        negative: ['摆拍感', '过度锐化', '滤镜过重']
      },
      axes: [
        { id: 'time', label: '时间', values: ['清晨', '正午', '黄昏'] },
        { id: 'place', label: '地点', values: ['码头', '街道', '海边'] }
      ],
      shots: [
        { code: 'S01', title: '出发', beat: '第一天', subject: '行李与车票', action: '放在长椅上', scene: '码头', detail: '清晨的雾还没散', axisValues: { time: '清晨', place: '码头' } },
        { code: 'S02', title: '街角', beat: '第二天', subject: '街边小店', action: '老板在收拾桌椅', scene: '街道', detail: '正午的硬光', axisValues: { time: '正午', place: '街道' } },
        { code: 'S03', title: '落日', beat: '第三天', subject: '海岸线', action: '浪打在礁石上', scene: '海边', detail: '黄昏把海面压成金色', axisValues: { time: '黄昏', place: '海边' } }
      ]
    }
  ];

  const byId = new Map(TEMPLATES.map(template => [template.id, template]));

  const api = { TEMPLATES, byId };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SeriesTemplates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
