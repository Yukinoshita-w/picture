'use strict';

window.StyleTemplates = [
  {
    id: 'cinematic-noir',
    title: '电影 noir',
    category: 'cinematic',
    categoryLabel: '电影感',
    description: '低调光影、强烈明暗对比与胶片颗粒，适合叙事场景和人物海报。',
    image: 'https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&w=1200&q=85',
    prompt: '电影感 noir 场景，单一硬光从侧面切入，深黑阴影与细腻高光，潮湿街道反射霓虹，35mm 胶片颗粒，低饱和冷色调，强烈纵深，叙事性构图，真实摄影质感，海报级细节'
  },
  {
    id: 'editorial-fashion',
    title: '杂志时装',
    category: 'editorial',
    categoryLabel: '杂志编辑',
    description: '干净背景、克制姿态和高级棚拍光线，适合品牌与时尚视觉。',
    image: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=1200&q=85',
    prompt: '高端时装杂志大片，人物穿着结构感现代服装，极简灰白背景，柔和但有方向性的棚拍光线，克制优雅的姿态，清晰面料纹理，留白构图，精致妆容，时尚摄影，8k 细节'
  },
  {
    id: 'watercolor-garden',
    title: '透明水彩',
    category: 'illustration',
    categoryLabel: '插画',
    description: '轻盈透明的色层和手绘边缘，适合自然、生活方式与书籍插图。',
    image: 'https://images.unsplash.com/photo-1541701494587-cb58502866ab?auto=format&fit=crop&w=1200&q=85',
    prompt: '透明水彩插画风格的静谧花园，层叠的绿叶与野花，纸张纤维清晰可见，水彩晕染和自然留白，柔和春日配色，轻微手绘线稿，温柔诗意，适合绘本内页，高清扫描质感'
  },
  {
    id: 'isometric-3d',
    title: '等距 3D',
    category: '3d',
    categoryLabel: '3D 设计',
    description: '清晰结构、柔和阴影和小型场景叙事，适合产品概念与信息图。',
    image: 'https://images.unsplash.com/photo-1634017839464-5c339ebe3cb4?auto=format&fit=crop&w=1200&q=85',
    prompt: '等距视角 3D 微缩场景，几何化建筑与小物件，柔和环境光和接触阴影，哑光材质，简洁的奶油色与珊瑚色配色，层次清晰，干净背景，产品概念展示，Octane 渲染，细节丰富'
  },
  {
    id: 'brutalist-architecture',
    title: '建筑纪实',
    category: 'architecture',
    categoryLabel: '建筑',
    description: '强调材质、尺度和几何关系，适合建筑提案与空间灵感。',
    image: 'https://images.unsplash.com/photo-1518005020951-eccb494ad742?auto=format&fit=crop&w=1200&q=85',
    prompt: '当代粗野主义建筑摄影，裸露混凝土、锐利几何体与重复结构，正午硬光制造清晰阴影，低机位广角构图，人物作为尺度参照，灰色与暖色混凝土纹理，建筑杂志摄影，极简克制'
  },
  {
    id: 'dreamy-landscape',
    title: '梦幻风景',
    category: 'nature',
    categoryLabel: '自然',
    description: '开阔空间、薄雾和柔和色彩，适合封面、壁纸和情绪画面。',
    image: 'https://images.unsplash.com/photo-1500534623283-312aade485b7?auto=format&fit=crop&w=1200&q=85',
    prompt: '梦幻晨雾山谷，远处层叠山脉被金色日出照亮，前景有安静的湖面和细小野花，空气透视，柔和粉蓝色调，宁静而辽阔，电影宽幅构图，细腻自然光，风景壁纸级画面'
  },
  {
    id: 'product-studio',
    title: '产品棚拍',
    category: 'product',
    categoryLabel: '产品',
    description: '干净的商业布光和明确主体，适合电商、包装与品牌展示。',
    image: 'https://images.unsplash.com/photo-1556229010-6c3f2c9ca5f8?auto=format&fit=crop&w=1200&q=85',
    prompt: '高端产品摄影，一件极简护肤产品置于浅色石材台面，侧上方柔光箱，清晰轮廓与自然接触阴影，少量绿植作为陪体，米白与鼠尾草绿色配色，干净留白，商业广告质感，真实材质细节'
  },
  {
    id: 'retro-poster',
    title: '复古海报',
    category: 'graphic',
    categoryLabel: '平面设计',
    description: '怀旧印刷纹理、强烈构成和有限配色，适合活动海报与封面。',
    image: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=1200&q=85',
    prompt: '1970 年代复古平面海报，粗体几何构成，橙红、芥末黄与深棕有限配色，丝网印刷颗粒和轻微套色偏移，充满节奏的放射线，留出标题区域，怀旧但现代，平面设计作品集质感'
  },
  {
    id: 'soft-portrait',
    title: '自然人像',
    category: 'portrait',
    categoryLabel: '人物',
    description: '自然光、真实肤质和松弛表情，适合头像、人物故事与品牌内容。',
    image: 'https://images.unsplash.com/photo-1488426862026-3ee34a7d66df?auto=format&fit=crop&w=1200&q=85',
    prompt: '自然窗边人像摄影，人物神态松弛而真实，侧脸被柔和散射光照亮，保留自然肤质和细小表情，浅色针织服装，背景轻微虚化，温暖中性色调，50mm 镜头，生活方式杂志质感'
  },
  {
    id: 'paper-collage',
    title: '纸张拼贴',
    category: 'illustration',
    categoryLabel: '插画',
    description: '剪纸边缘、纸张层次和大胆色块，适合社交媒体与创意主题。',
    image: 'https://images.unsplash.com/photo-1549490349-8643362247b5?auto=format&fit=crop&w=1200&q=85',
    prompt: '现代纸张拼贴插画，植物、太阳和抽象人物由不同纹理纸片组成，清晰剪裁边缘，层层叠放形成真实阴影，靛蓝、珊瑚红与奶油色，大胆留白，独立出版物封面，手工艺术质感'
  },
  {
    id: 'cyberpunk-city',
    title: '霓虹赛博',
    category: 'cinematic',
    categoryLabel: '电影感',
    description: '霓虹色光源、湿润街道和未来城市，适合科幻概念与游戏视觉。',
    image: 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=1200&q=85',
    prompt: '未来赛博朋克城市夜景，密集高楼和悬浮广告牌，洋红与青蓝霓虹在雨后街道反射，远处有薄雾和飞行器，低机位广角，丰富但有秩序的细节，电影概念设计，强烈氛围光'
  },
  {
    id: 'minimal-interior',
    title: '极简空间',
    category: 'architecture',
    categoryLabel: '建筑',
    description: '平静的材质、秩序和光线，适合室内设计与生活方式内容。',
    image: 'https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&w=1200&q=85',
    prompt: '极简现代室内空间，浅色木材、米白墙面和一把雕塑感座椅，大片窗户投下柔和斜向光影，材质细节真实，构图平衡而安静，低饱和自然配色，室内设计杂志摄影，干净无杂物'
  }
];
