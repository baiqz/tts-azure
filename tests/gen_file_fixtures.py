# -*- coding: utf-8 -*-
"""
gen_file_fixtures.py —— 生成「读取文件」功能的测试样本

为什么要落成真实文件而不是内联字符串：
  · GBK / UTF-8-BOM 这些编码问题，只有真正的字节才能验证
  · docx 是 zip 容器，必须是真的 zip（含中央目录、deflate 条目）才算测到点子上

产物在 tests/fixtures/ 下，都是小文件，可以放心提交进仓库。
"""
import io
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
os.makedirs(FIX, exist_ok=True)

CN_TEXT = "这是一份用来测编码的文稿。\n第二行：中文标点，逗号、顿号，还有数字 123 和英文 hello。\n"


def write(name, data):
    p = os.path.join(FIX, name)
    with open(p, "wb") as f:
        f.write(data)
    print("  %-24s %6d 字节" % (name, len(data)))


# ---------------------------------------------------------------- 编码样本
write("sample_utf8.txt", CN_TEXT.encode("utf-8"))
write("sample_gbk.txt", CN_TEXT.encode("gbk"))
write("sample_utf8bom.txt", b"\xef\xbb\xbf" + CN_TEXT.encode("utf-8"))
write("sample_utf16le.txt", b"\xff\xfe" + CN_TEXT.encode("utf-16-le"))


# ---------------------------------------------------------------- docx 样本
CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>"""

DOCUMENT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>第一段：这是 Word 文档里的正文。</w:t></w:r></w:p>
<w:p><w:r><w:t>第二段有特殊字符 &amp; &lt;尖括号&gt; 和 &#x4E2D;文字。</w:t></w:r></w:p>
<w:p><w:r><w:t>行A</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>行B</w:t></w:r></w:p>
<w:p><w:r><w:t>制表</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>后面</w:t></w:r></w:p>
<w:p><w:del><w:r><w:delText>这段是修订删除的内容，不该出现</w:delText></w:r></w:del></w:p>
<w:p><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t>最后一段。</w:t></w:r></w:p>
</w:body>
</w:document>"""


def make_docx(name, method):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", method) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/_rels/document.xml.rels", DOC_RELS)
        z.writestr("word/document.xml", DOCUMENT)
    write(name, buf.getvalue())


make_docx("sample.docx", zipfile.ZIP_DEFLATED)   # method=8，走 inflate
make_docx("sample_stored.docx", zipfile.ZIP_STORED)  # method=0，直接取

# 一个"假 docx"：改了后缀的纯文本，用来验证报错信息是人话
write("fake.docx", "这不是真的 docx，只是改了后缀。".encode("utf-8"))

print("\n完成，输出目录：%s" % FIX)
