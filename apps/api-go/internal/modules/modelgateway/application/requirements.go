package application

// Requirement describes product intent, not a registered or available model.
// Runtime availability is exclusively supplied by the independent Router.
type Requirement struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Kind        string   `json:"kind"`
	Priority    string   `json:"priority"`
	InputKinds  []string `json:"inputKinds"`
	OutputKinds []string `json:"outputKinds"`
	Features    []string `json:"features"`
}

func Requirements() []Requirement {
	return []Requirement{
		{"language", "语言与多模态理解", "LLM", "P0", []string{"TEXT", "IMAGE", "VIDEO"}, []string{"TEXT", "STRUCTURED"}, []string{"首页及画布多轮对话", "剧本与分镜规划", "提示词优化", "图片风格提取与反推提示词", "图片及视频分析", "歌词生成"}},
		{"image-generation", "文生图", "TEXT_TO_IMAGE", "P0", []string{"TEXT"}, []string{"IMAGE"}, []string{"角色与场景设计", "分镜图", "实时画板的手动生成"}},
		{"image-reference", "图生图与参考图", "IMAGE_TO_IMAGE", "P0", []string{"TEXT", "IMAGE"}, []string{"IMAGE"}, []string{"角色及风格一致性", "分镜大师与三视图", "全景图", "实时画板参考生成"}},
		{"image-edit", "图像生成式编辑", "IMAGE_EDIT", "P1", []string{"TEXT", "IMAGE"}, []string{"IMAGE"}, []string{"局部重绘与蒙版", "擦除", "扩图"}},
		{"image-cutout", "抠图与去文字", "IMAGE_CUTOUT", "P1", []string{"TEXT", "IMAGE"}, []string{"IMAGE"}, []string{"抠图", "擦除文字", "元素拆分的独立抠图阶段"}},
		{"image-layers", "图层拆分", "IMAGE_LAYER_DECOMPOSITION", "P1", []string{"IMAGE"}, []string{"IMAGE", "STRUCTURED"}, []string{"编辑元素与图层"}},
		{"image-enhancement", "图像增强", "IMAGE_ENHANCE", "P1", []string{"IMAGE"}, []string{"IMAGE"}, []string{"高清增强", "放大", "修复"}},
		{"image-camera", "多角度与照明", "IMAGE_VARIATION", "P1", []string{"TEXT", "IMAGE"}, []string{"IMAGE"}, []string{"多角度相机", "多角度照明"}},
		{"text-video", "文生视频", "TEXT_TO_VIDEO", "P0", []string{"TEXT"}, []string{"VIDEO"}, []string{"文本视频节点"}},
		{"image-video", "图生视频", "IMAGE_TO_VIDEO", "P0", []string{"TEXT", "IMAGE"}, []string{"VIDEO"}, []string{"单图视频", "首帧视频", "首尾帧视频"}},
		{"omni-reference", "全能参考", "OMNI_REFERENCE", "P0", []string{"TEXT", "IMAGE", "VIDEO", "AUDIO"}, []string{"VIDEO"}, []string{"角色风格及动作参考", "图片视频音频组合参考"}},
		{"video-edit", "视频编辑与续写", "VIDEO_TO_VIDEO", "P1", []string{"TEXT", "IMAGE", "VIDEO", "AUDIO"}, []string{"VIDEO"}, []string{"视频编辑生成", "视频续写", "片段重拍的生成阶段", "动作迁移"}},
		{"video-enhancement", "视频增强与修复", "VIDEO_ENHANCE", "P1", []string{"VIDEO"}, []string{"VIDEO"}, []string{"高清与放大", "增强", "降噪与补帧", "去水印字幕与模糊"}},
		{"video-depth", "视频深度转换", "VIDEO_DEPTH", "P2", []string{"VIDEO"}, []string{"VIDEO"}, []string{"深度图与后续压缩"}},
		{"speech", "语音生成", "TEXT_TO_AUDIO", "P1", []string{"TEXT"}, []string{"AUDIO"}, []string{"文本转语音", "音色与说话参数"}},
		{"music", "音乐生成", "TEXT_TO_MUSIC", "P1", []string{"TEXT"}, []string{"AUDIO"}, []string{"配乐与歌词歌曲"}},
		{"audio-reference", "参考音频生成", "AUDIO_TO_AUDIO", "P1", []string{"TEXT", "AUDIO"}, []string{"AUDIO"}, []string{"参考音频与音色"}},
		{"audio-separation", "音频分离", "AUDIO_SEPARATION", "P1", []string{"VIDEO", "AUDIO"}, []string{"AUDIO"}, []string{"全部音频", "人声", "环境音"}},
		{"model-3d", "3D 模型生成", "GENERATE_3D_MODEL", "P2", []string{"TEXT", "IMAGE"}, []string{"FILE", "IMAGE"}, []string{"文本或多视图生成模型", "纹理与封面产物"}},
		{"world-3d", "3D 世界生成", "GENERATE_3D_WORLD", "P2", []string{"TEXT", "IMAGE", "VIDEO"}, []string{"FILE", "IMAGE"}, []string{"文本图片视频生成世界"}},
	}
}
