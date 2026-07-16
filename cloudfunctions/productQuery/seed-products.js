const CATEGORY_NAMES = {
  digital: '数码',
  books: '书籍',
  life: '生活',
  clothing: '服饰',
  sports: '运动',
  other: '其他'
};

const SEED_ROWS = [
  ['product-001', '九成新机械键盘', '功能正常，键帽无明显磨损，附数据线，校内面交可现场试用。', 129, 299, 'digital', '九成新', ['键盘', '外设'], '一号食堂附近', '2026-07-16T08:00:00.000Z', 'available', 'user-001', '校园用户', 8, 126, '键盘', 'mint'],
  ['product-002', '高等数学同济第七版上下册', '有少量课堂笔记，不影响阅读，适合大一预习和期末复习。', 28, 86, 'books', '八成新', ['教材', '高数'], '图书馆南门', '2026-07-15T12:00:00.000Z', 'available', 'user-002', '爱读书的同学', 12, 208, '高数', 'blue'],
  ['product-004', '简约连帽卫衣 M 码', '春秋薄款，颜色耐看，洗净后收纳，无破损和明显污渍。', 45, 139, 'clothing', '九成新', ['卫衣', '春秋'], '东区操场', '2026-07-14T09:00:00.000Z', 'available', 'user-004', '东区同学', 14, 331, '卫衣', 'rose'],
  ['product-005', '羽毛球拍双拍套装', '两支球拍加拍包，线床状态良好，已和同学约好周末面交。', 68, 158, 'sports', '八成新', ['羽毛球', '运动'], '体育馆门口', '2026-07-13T07:30:00.000Z', 'reserved', 'user-005', '运动搭子', 18, 412, '球拍', 'lime'],
  ['product-006', 'Type-C 六口扩展坞', '支持 HDMI、USB 和读卡，接口均正常，换电脑后闲置。', 75, 169, 'digital', '九成新', ['电脑配件', 'Type-C'], '信息楼大厅', '2026-07-12T10:00:00.000Z', 'available', 'user-006', '代码还没跑', 9, 267, '扩展坞', 'violet'],
  ['product-007', '不锈钢保温杯 500ml', '密封正常，无异味，杯身有轻微使用痕迹，已完成清洁。', 22, 59, 'life', '七成新', ['水杯', '日用'], '二号食堂', '2026-07-11T13:00:00.000Z', 'available', 'user-007', '二食堂常客', 3, 89, '水杯', 'cyan'],
  ['product-008', '校园手绘明信片一套', '社团活动剩余纪念品，共八张不同校园场景，可作收藏。', 15, 25, 'other', '全新', ['文创', '校园'], '学生活动中心', '2026-07-10T05:00:00.000Z', 'available', 'user-008', '手绘社同学', 26, 486, '明信片', 'orange'],
  ['product-009', '降噪蓝牙耳机', '连接稳定，充电盒和左右耳均正常，附替换耳帽和充电线。', 96.5, 249, 'digital', '八成新', ['耳机', '降噪'], '教学楼连廊', '2026-07-09T15:20:00.000Z', 'available', 'user-009', '晚课选手', 17, 356, '耳机', 'indigo'],
  ['product-010', '考研英语真题与词汇资料', '真题册保存完整，词汇书有少量勾画，适合开始复习的同学。', 32, 118, 'books', '八成新', ['考研', '英语'], '研究生自习室外', '2026-07-08T04:30:00.000Z', 'available', 'user-010', '早起背单词', 11, 199, '考研', 'amber'],
  ['product-011', '护眼夹式宿舍台灯', '三档亮度，夹子牢固，USB 供电，适合床头看书使用。', 26, 55, 'life', '九成新', ['台灯', '宿舍'], '梅园宿舍门口', '2026-07-07T11:00:00.000Z', 'available', 'user-011', '梅园夜读', 7, 148, '台灯', 'coral'],
  ['product-012', '带盖宿舍收纳箱', '大号透明收纳箱，箱盖和卡扣完整，适合整理换季衣物。', 18, 42, 'life', '八成新', ['收纳箱', '整理'], '北门快递点旁', '2026-07-06T06:00:00.000Z', 'available', 'user-012', '整理进行时', 5, 103, '收纳', 'sage'],
  ['product-013', '轻便通勤双肩包', '可放 14 英寸电脑，肩带完好，内部隔层干净，日常上课够用。', 58, 159, 'clothing', '九成新', ['双肩包', '通勤'], '西区教学楼', '2026-07-05T09:30:00.000Z', 'available', 'user-013', '赶早八的人', 10, 238, '背包', 'slate'],
  ['product-014', '瑜伽垫与拉力带', '瑜伽垫厚度适中，附两条不同阻力拉力带，已清洁消毒。', 39, 98, 'sports', '八成新', ['瑜伽', '健身'], '风雨操场入口', '2026-07-04T02:15:00.000Z', 'available', 'user-014', '每周练两次', 6, 172, '瑜伽', 'mint'],
  ['product-015', '校园代步小鱼板', '轮子顺滑，板面有正常使用痕迹，商品已完成校内面交。', 80, 189, 'sports', '七成新', ['滑板', '代步'], '南门广场', '2026-07-03T08:40:00.000Z', 'sold', 'user-015', '滑去上课', 21, 521, '滑板', 'orange'],
  ['product-016', '免费赠送空白笔记本', '活动剩余两本空白笔记本，封面有轻微压痕，有需要可校内自取。', 0, null, 'other', '九成新', ['免费', '笔记本'], '公共教学楼大厅', '2026-07-02T13:10:00.000Z', 'available', 'user-016', '活动志愿者', 0, 0, '赠送', 'blue'],
  ['product-017', '宿舍静音小风扇', '三档风速，USB 供电，暂时下架，整理配件后再发布。', 24, 49, 'life', '八成新', ['风扇', '宿舍'], '兰园宿舍区', '2026-07-01T10:00:00.000Z', 'offline', 'user-017', '怕热同学', 2, 67, '风扇', 'cyan']
];

function toSeedProduct(row) {
  const [
    id,
    title,
    description,
    price,
    originalPrice,
    categoryId,
    condition,
    tags,
    location,
    createdAt,
    status,
    sellerId,
    sellerName,
    favoriteCount,
    viewCount,
    coverLabel,
    coverTone
  ] = row;

  return {
    _id: id,
    title,
    description,
    price,
    originalPrice,
    categoryId,
    categoryName: CATEGORY_NAMES[categoryId] || CATEGORY_NAMES.other,
    condition,
    images: [],
    coverImage: '',
    coverLabel,
    coverTone,
    location,
    campus: '示例校园',
    distanceText: status === 'sold' ? '已完成面交' : '校内面交',
    sellerId,
    sellerName,
    sellerAvatar: '',
    sellerVerified: false,
    status,
    tags,
    viewCount,
    favoriteCount,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt)
  };
}

const SEED_PRODUCTS = SEED_ROWS.map(toSeedProduct);

module.exports = {
  SEED_PRODUCTS
};
