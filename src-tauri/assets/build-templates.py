"""生成空白 Office 模板（最小 OOXML，无作者/缩略图等元数据，字节可复现）。

为什么不用 python-docx / openpyxl / python-pptx 直接 save：
它们会把自带的默认模板整包搬来（docx 826KB、含 thumbnail.jpeg 和作者信息），
既臃肿又带元数据。这里只手写必需部件，体积 ~2-6KB，且内容完全确定。

输出：C:\\...\\tpl\\blank.docx / blank.xlsx / blank.pptx
"""
import os
import zipfile

OUT = os.path.dirname(os.path.abspath(__file__))

R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_R = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
SS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
XMLHEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'


def rels(items):
    """items: ((id, type, target), ...)"""
    body = "".join(
        f'<Relationship Id="{i}" Type="{t}" Target="{g}"/>' for i, t, g in items
    )
    return f"{XMLHEAD}<Relationships xmlns=\"{PKG_R}\">{body}</Relationships>"
    return f"{XMLHEAD}<Relationships xmlns=\"{PKG_R}\">{body}</Relationships>"


def types(defaults, overrides):
    d = "".join(
        f'<Default Extension="{e}" ContentType="{c}"/>' for e, c in defaults
    )
    o = "".join(f'<Override PartName="{p}" ContentType="{c}"/>' for p, c in overrides)
    return f"{XMLHEAD}<Types xmlns=\"{CT}\">{d}{o}</Types>"


D_RELS = ("rels", "application/vnd.openxmlformats-package.relationships+xml")
D_XML = ("xml", "application/xml")

# ─────────────────────────── docx ───────────────────────────
DOCX = {
    "[Content_Types].xml": types(
        [D_RELS, D_XML],
        [
            (
                "/word/document.xml",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
            ),
            (
                "/word/styles.xml",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
            ),
        ],
    ),
    "_rels/.rels": rels((("rId1", f"{R}/officeDocument", "word/document.xml"),)),
    "word/_rels/document.xml.rels": rels(
        (("rId1", f"{R}/styles", "styles.xml"),)
    ),
    "word/document.xml": (
        f'{XMLHEAD}<w:document xmlns:w="{W}"><w:body><w:p/>'
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"'
        ' w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'
        "</w:body></w:document>"
    ),
    # A4 纵向 + 中文默认字体，避免打开是 Letter 且字体回退
    "word/styles.xml": (
        f'{XMLHEAD}<w:styles xmlns:w="{W}"><w:docDefaults>'
        "<w:rPrDefault><w:rPr>"
        '<w:rFonts w:ascii="Calibri" w:eastAsia="宋体" w:hAnsi="Calibri" w:cs="Times New Roman"/>'
        '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>'
        '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259"'
        ' w:lineRule="auto"/></w:pPr></w:pPrDefault>'
        "</w:docDefaults>"
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">'
        '<w:name w:val="Normal"/><w:qFormat/></w:style>'
        "</w:styles>"
    ),
}

# ─────────────────────────── xlsx ───────────────────────────
XLSX = {
    "[Content_Types].xml": types(
        [D_RELS, D_XML],
        [
            (
                "/xl/workbook.xml",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
            ),
            (
                "/xl/worksheets/sheet1.xml",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
            ),
            (
                "/xl/styles.xml",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
            ),
        ],
    ),
    "_rels/.rels": rels((("rId1", f"{R}/officeDocument", "xl/workbook.xml"),)),
    "xl/_rels/workbook.xml.rels": rels(
        (
            ("rId1", f"{R}/worksheet", "worksheets/sheet1.xml"),
            ("rId2", f"{R}/styles", "styles.xml"),
        )
    ),
    "xl/workbook.xml": (
        f'{XMLHEAD}<workbook xmlns="{SS}" xmlns:r="{R}"><sheets>'
        '<sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
    ),
    "xl/worksheets/sheet1.xml": (
        f'{XMLHEAD}<worksheet xmlns="{SS}"><sheetData/></worksheet>'
    ),
    # 缺 styles.xml 时 Excel 会报「发现不可读取的内容」
    "xl/styles.xml": (
        f'{XMLHEAD}<styleSheet xmlns="{SS}">'
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/>'
        "<diagonal/></border></borders>"
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0"'
        ' borderId="0"/></cellStyleXfs>'
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"'
        ' xfId="0"/></cellXfs>'
        "</styleSheet>"
    ),
}

# ─────────────────────────── pptx ───────────────────────────
# fmtScheme 必须各含 3 项（fill/line/effect/bgFill），否则 PowerPoint 直接判定文件损坏
_THEME = (
    f'{XMLHEAD}<a:theme xmlns:a="{A}" name="Office 主题"><a:themeElements>'
    "<a:clrScheme name=\"Office\">"
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2>'
    '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>'
    '<a:accent1><a:srgbClr val="4472C4"/></a:accent1>'
    '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
    '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>'
    '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
    '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>'
    '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>'
    '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
    "</a:clrScheme>"
    '<a:fontScheme name="Office">'
    '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="宋体"/>'
    '<a:cs typeface=""/></a:majorFont>'
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="宋体"/>'
    '<a:cs typeface=""/></a:minorFont>'
    "</a:fontScheme>"
    '<a:fmtScheme name="Office">'
    "<a:fillStyleLst>"
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    '<a:gradFill rotWithShape="1"><a:gsLst>'
    '<a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/>'
    '<a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs>'
    '<a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/>'
    '<a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs>'
    '<a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/>'
    '<a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs>'
    '</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>'
    '<a:gradFill rotWithShape="1"><a:gsLst>'
    '<a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/>'
    '<a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs>'
    '<a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/>'
    '<a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs>'
    '<a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/>'
    '<a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs>'
    '</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>'
    "</a:fillStyleLst>"
    "<a:lnStyleLst>"
    '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr">'
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    '<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>'
    '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr">'
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    '<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>'
    '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr">'
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    '<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>'
    "</a:lnStyleLst>"
    "<a:effectStyleLst>"
    '<a:effectStyle><a:effectLst/></a:effectStyle>'
    '<a:effectStyle><a:effectLst/></a:effectStyle>'
    '<a:effectStyle><a:effectLst>'
    '<a:outerShdw blurRad="57150" dist="19050" dir="5400000" rotWithShape="0">'
    '<a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw>'
    "</a:effectLst></a:effectStyle>"
    "</a:effectStyleLst>"
    "<a:bgFillStyleLst>"
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    '<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/>'
    '<a:satMod val="170000"/></a:schemeClr></a:solidFill>'
    '<a:gradFill rotWithShape="1"><a:gsLst>'
    '<a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/>'
    '<a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/>'
    "</a:schemeClr></a:gs>"
    '<a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/>'
    '<a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/>'
    "</a:schemeClr></a:gs>"
    '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/>'
    '<a:satMod val="120000"/></a:schemeClr></a:gs>'
    '</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>'
    "</a:bgFillStyleLst>"
    "</a:fmtScheme></a:themeElements>"
    '<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
)

# 每张幻灯片的 spTree 骨架都长这样，抽出来避免重复
def _sptree(name=""):
    return (
        "<p:spTree>"
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>'
        "</p:nvGrpSpPr>"
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
        '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        "</p:spTree>"
    ) if name is None else (
        "<p:spTree>"
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>'
        "</p:nvGrpSpPr>"
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
        '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        "</p:spTree>"
    )


PPTX = {
    "[Content_Types].xml": types(
        [D_RELS, D_XML],
        [
            (
                "/ppt/presentation.xml",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
            ),
            (
                "/ppt/slideMasters/slideMaster1.xml",
                "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
            ),
            (
                "/ppt/slideLayouts/slideLayout1.xml",
                "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
            ),
            (
                "/ppt/slides/slide1.xml",
                "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
            ),
            (
                "/ppt/theme/theme1.xml",
                "application/vnd.openxmlformats-officedocument.theme+xml",
            ),
        ],
    ),
    "_rels/.rels": rels((("rId1", f"{R}/officeDocument", "ppt/presentation.xml"),)),
    "ppt/_rels/presentation.xml.rels": rels(
        (
            ("rId1", f"{R}/slideMaster", "slideMasters/slideMaster1.xml"),
            ("rId2", f"{R}/slide", "slides/slide1.xml"),
            ("rId3", f"{R}/theme", "theme/theme1.xml"),
        )
    ),
    # sldIdLst 里必须真有一页，否则 PowerPoint 打开即报错
    "ppt/presentation.xml": (
        f'{XMLHEAD}<p:presentation xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/>'
        "</p:sldMasterIdLst>"
        '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>'
        '<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>'
        '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>'
    ),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": rels(
        (
            ("rId1", f"{R}/slideLayout", "../slideLayouts/slideLayout1.xml"),
            ("rId2", f"{R}/theme", "../theme/theme1.xml"),
        )
    ),
    "ppt/slideMasters/slideMaster1.xml": (
        f'{XMLHEAD}<p:sldMaster xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}">'
        "<p:cSld>"
        '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
        f"{_sptree()}</p:cSld>"
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"'
        ' accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5"'
        ' accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/>'
        "</p:sldLayoutIdLst>"
        '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>'
        "</p:sldMaster>"
    ),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels(
        (("rId1", f"{R}/slideMaster", "../slideMasters/slideMaster1.xml"),)
    ),
    "ppt/slideLayouts/slideLayout1.xml": (
        f'{XMLHEAD}<p:sldLayout xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}"'
        ' type="blank" preserve="1"><p:cSld name="空白">'
        f"{_sptree()}</p:cSld>"
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
    ),
    "ppt/slides/_rels/slide1.xml.rels": rels(
        (("rId1", f"{R}/slideLayout", "../slideLayouts/slideLayout1.xml"),)
    ),
    "ppt/slides/slide1.xml": (
        f'{XMLHEAD}<p:sld xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}"><p:cSld>'
        f"{_sptree()}</p:cSld>"
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
    ),
    "ppt/theme/theme1.xml": _THEME,
}


def build(name, parts):
    path = os.path.join(OUT, name)
    # 固定时间戳 → 每次生成字节一致，便于校验与版本控制
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for part, data in parts.items():
            info = zipfile.ZipInfo(part, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, data.encode("utf-8"))
    print(f"{name}: {os.path.getsize(path)} bytes, {len(parts)} parts")
    return path


if __name__ == "__main__":
    build("blank.docx", DOCX)
    build("blank.xlsx", XLSX)
    build("blank.pptx", PPTX)
