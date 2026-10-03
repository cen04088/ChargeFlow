import { ListHeader, Paragraph } from "@toss/tds-mobile";
import { adaptive } from "@toss/tds-colors";

/** 제목 + (선택) 설명. 긴 설명이 ListHeader 안에서 제목과 겹치지 않도록 따로 그린다. */
export function SectionHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <>
      <ListHeader
        title={
          <ListHeader.TitleParagraph fontWeight="bold">
            {title}
          </ListHeader.TitleParagraph>
        }
      />
      {description && (
        <div className="section-pad section-desc">
          <Paragraph typography="t6" color={adaptive.grey600}>
            {description}
          </Paragraph>
        </div>
      )}
    </>
  );
}
