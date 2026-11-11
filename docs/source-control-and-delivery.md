# 源码与交付

源码：[shanghe000/studio-tv](https://github.com/shanghe000/studio-tv)。
交付工具：[studio-delivery](https://github.com/shanghe000/studio-delivery)。

每次变更提交真实测试结果；发布前固定源码、配置与镜像摘要。使用独立测试数据库和显式 mock，不以生产凭据执行测试。

运行环境通过外部配置提供身份、数据库与模型服务。数据库迁移只追加，应用回退须兼容已有数据。

GitHub 的 Publication readiness 检查负责发布内容门槛，不部署应用、不变更仓库可见性。项目测试、第三方许可核对与全历史凭据扫描均须独立完成。
