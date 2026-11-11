# 设计验证

2026-10-05，代码基线 `f8c6529`。本目录 `database.sql` 是完整设计蓝图，**没有放入 migrations，不由服务启动加载**。

已完成：

- PostgreSQL 17隔离容器中，先加载既有001/002/003，再应用蓝图：57张新表成功创建。
- 62项数据库检查通过：owner复合FK、混合目录与防环、typed版本/active_version、版本行不可改删、固定快照、verified Blob不可改内容、跨任务引用、过期fence回写0行、历史隐藏保留输出、HF首次绑定等。
- 5项上传凭据筛选条件验证通过；它们只验证purpose/READY/工程绑定的预期SQL谓词，**不表示DDL保证这些业务条件，也不表示Go用例已实现**。
- 全部18项合同检查通过，包含新领域合同格式、JSON/YAML一致、有效/无效请求样例、119个操作的真实表映射、冻结核心SHA及新合同未注册。
- 测试数据回滚；临时容器、tmpfs数据库全部销毁。未读取生产环境文件、连接生产数据库或部署应用。

最终蓝图SHA256前16位：`cea8116e01fd916a`。重现数据库验证（需Python3、SSH deployment-host、远端缓存的postgres:17-alpine）：

```sh
python3 tests/design/validate_database.py
```

验证器仅创建自己的唯一临时容器，无网络、无公开端口，以创建返回的确切容器ID执行及清理。合同验证使用 `tests/contracts/requirements.txt` 中固定依赖：

```sh
python3 tests/contracts/build_domain_extension.py
python3 -m unittest discover -s tests/contracts -p 'test_*.py'
```

这证明设计SQL可执行、已测试约束成立及合同自洽；存量生产数据升级、DDD代码依赖、真实worker/模型、原生兼容层和UI回归仍需在对应实现阶段验证。发布前先审计存量owner不一致与引用，再拆阶段增量迁移。

## ER/DBML模型

[分模块ER图](../database-er.md)和[完整DBML](database.dbml)由同一份PostgreSQL元数据生成。模型覆盖57张新增规划表、10张既有表，共667列、126条真实外键；11个Mermaid ER图按模块展示。首期16张是范围建议，尚未生成首期迁移。

`database-model.json`只保存结构元数据和源文件SHA256，不包含用户数据。重建时同样使用隔离PG17容器，完成后销毁：

```sh
python3 tests/design/build_database_model.py
```

离线验证DBML语法、表/列/主键/外键与元数据一致性、源文件哈希和11个Mermaid ER图语法（文档工具安装在忽略的.local目录，不影响应用依赖）：

```sh
npm install --prefix .local/er-tools --no-audit --no-fund --save-exact @dbml/core@10.2.0 mermaid@12.1.0
node tests/design/validate_database_model.mjs
```

以上检查已通过；DBML用于查看关系，不替代PostgreSQL蓝图中的触发器、生成列及条件索引。
